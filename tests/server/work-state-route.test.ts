// SPDX-License-Identifier: Apache-2.0
//
// /v1/work-state: the server runtime's store for work_state_write. Writes are
// appended and read back in write order, scoped to the caller's team and
// project; `name:<project>` resolves as on the other routes (created on
// write, an unknown name reads empty); lists only the viewer writes are
// refused, as the local worker refuses them.
// Postgres-gated; isolation via tests/sdk/pg-isolation.ts.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
} from '../../src/storage/postgres/index.js';
import { DisabledServerQueueManager } from '../../src/server/runtime/types.js';
import { logger } from '../../src/utils/logger.js';
import { toWorkStateEntries } from '../../src/services/context/ServerWorkState.js';
import { workStateReadReply } from '../../src/shared/work-state-write.js';
import { newApiKey, createIsolatedSchema, dropSchema } from '../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('/v1/work-state', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let server: Server;
  let port: number;
  let teamKey: string;
  let otherTeamKey: string;
  let projectScopedKey: string;
  let projectId: string;
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    spies = (['info', 'warn', 'error', 'debug'] as const).map((level) =>
      spyOn(logger, level).mockImplementation(() => {}),
    );
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_work_state');
    pool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName},public` });
    client = await pool.connect();
    await bootstrapServerPostgresSchema(pool, 'off');
    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'team' });
    const otherTeam = await storage.teams.create({ name: 'other' });
    projectId = (await storage.projects.create({ teamId: team.id, name: 'repo' })).id;
    const issue = async (teamId: string, scopedProjectId: string | null): Promise<string> => {
      const key = newApiKey();
      await storage.auth.createApiKey({
        keyHash: key.hash, teamId, projectId: scopedProjectId, actorId: 't', scopes: ['memories:read', 'memories:write'],
      });
      return key.raw;
    };
    teamKey = await issue(team.id, null);
    otherTeamKey = await issue(otherTeam.id, null);
    const sideProject = (await storage.projects.create({ teamId: team.id, name: 'side' })).id;
    projectScopedKey = await issue(team.id, sideProject);

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never,
      queueManager: new DisabledServerQueueManager('disabled'),
      authMode: 'api-key',
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    client.release();
    await pool.end();
    await dropSchema(testDatabaseUrl!, schemaName);
    spies.forEach((spy) => spy.mockRestore());
    mock.restore();
  });

  async function post(path: string, body: Record<string, unknown>, key = teamKey): Promise<{ status: number; json: any }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  }

  it('appends writes and reads them back in write order, latest value winning', async () => {
    const first = await post('/v1/work-state/entries', { projectId, list: 'release', fields: { task: 'tag', status: 'doing' } });
    expect(first.status).toBe(201);
    expect(first.json.entries).toHaveLength(1);
    await post('/v1/work-state/entries', { projectId, list: 'notes', fields: { owner: 'me' } });
    const second = await post('/v1/work-state/entries', { projectId, list: 'release', fields: { task: 'tag', status: 'done' } });
    // The write answers with its own list only.
    expect(second.json.entries.map((entry: any) => entry.fields.status)).toEqual(['doing', 'done']);

    const all = await post('/v1/work-state/read', { projectId });
    expect(all.status).toBe(200);
    expect(all.json.entries.map((entry: any) => entry.list)).toEqual(['release', 'notes', 'release']);
    const one = await post('/v1/work-state/read', { projectId, list: 'release' });
    expect(one.json.entries).toHaveLength(2);

    // Folded by the shared renderer, the closed item is gone from the open view.
    const open = workStateReadReply(toWorkStateEntries(one.json.entries, 'repo'), {
      list: 'release', includeClosed: false, project: 'repo', nowEpoch: Date.now(),
    });
    expect(open).toContain('Nothing open in "release"');
  });

  it('keeps the key order of fields as written', async () => {
    await post('/v1/work-state/entries', { projectId, list: 'order', fields: { zeta: 1, alpha: 2, task: 't' } });
    const read = await post('/v1/work-state/read', { projectId, list: 'order' });
    expect(Object.keys(read.json.entries[0].fields)).toEqual(['zeta', 'alpha', 'task']);
  });

  it('resolves name references: a write creates the project, an unknown name reads empty', async () => {
    const unknown = await post('/v1/work-state/read', { projectId: 'name:fresh-repo' });
    expect(unknown.status).toBe(200);
    expect(unknown.json.entries).toEqual([]);
    const created = await post('/v1/work-state/entries', { projectId: 'name:fresh-repo', list: 'todo', fields: { task: 'a' } });
    expect(created.status).toBe(201);
    const read = await post('/v1/work-state/read', { projectId: 'name:fresh-repo' });
    expect(read.json.entries).toHaveLength(1);
    expect(read.json.entries[0].projectId).toBe(created.json.entry.projectId);
  });

  it('refuses viewer-only lists, reserved lists and bad fields', async () => {
    expect((await post('/v1/work-state/entries', { projectId, list: 'my-rules', fields: { task: 'x' } })).status).toBe(403);
    expect((await post('/v1/work-state/entries', { projectId, list: '__my_work_v1:x', fields: { a: 1 } })).status).toBe(400);
    expect((await post('/v1/work-state/entries', { projectId, list: 'l', fields: {} })).status).toBe(400);
    expect((await post('/v1/work-state/entries', { projectId, list: 'l', fields: { nested: { a: 1 } } })).status).toBe(400);
    expect((await post('/v1/work-state/read', { projectId })).json.entries).toEqual([]);
  });

  it('keeps other teams and other projects out', async () => {
    await post('/v1/work-state/entries', { projectId, list: 'secret', fields: { task: 'x' } });
    const otherTeamRead = await post('/v1/work-state/read', { projectId }, otherTeamKey);
    expect(otherTeamRead.json.entries ?? []).toEqual([]);
    const otherTeamWrite = await post('/v1/work-state/entries', { projectId, list: 'l', fields: { a: 1 } }, otherTeamKey);
    expect(otherTeamWrite.status).toBe(404);
    expect((await post('/v1/work-state/read', { projectId }, projectScopedKey)).status).toBe(403);
  });
});
