// SPDX-License-Identifier: Apache-2.0
//
// Several machines write one project. Each key is a machine with a label;
// rows carry their writing key: a read says whose each row is and whether the
// asking machine wrote it, filters by author, gives the asking machine most of
// a SessionStart window, and keeps each machine's to-do lists its own.
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
import { setAuthorLabel } from '../../src/storage/postgres/authors.js';
import { newApiKey, createIsolatedSchema, dropSchema } from '../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('authors: one key per machine', () => {
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
  let machineB: string;
  let otherTeamKey: string;
  let projectScopedKey: string;
  let projectId: string;
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    spies = (['info', 'warn', 'error', 'debug'] as const).map((level) =>
      spyOn(logger, level).mockImplementation(() => {}),
    );
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_authors');
    pool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName},public` });
    client = await pool.connect();
    await bootstrapServerPostgresSchema(pool, 'off');
    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'team' });
    const otherTeam = await storage.teams.create({ name: 'other' });
    projectId = (await storage.projects.create({ teamId: team.id, name: 'repo' })).id;
    const issue = async (teamId: string, scopedProjectId: string | null, label?: string): Promise<string> => {
      const key = newApiKey();
      const created = await storage.auth.createApiKey({
        keyHash: key.hash, teamId, projectId: scopedProjectId, actorId: 't', scopes: ['memories:read', 'memories:write'],
      });
      if (label) await setAuthorLabel(pool, created.id, label);
      return key.raw;
    };
    teamKey = await issue(team.id, null, 'A');
    machineB = await issue(team.id, null, 'B');
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

  it('says whose each row is and whether the asking machine wrote it', async () => {
    await post('/v1/memories', { projectId, content: 'Written on A' });
    await post('/v1/memories', { projectId, content: 'Written on B' }, machineB);
    const seenByA = (await post('/v1/search', { projectId, query: 'written' })).json.observations;
    const byContent = Object.fromEntries(seenByA.map((o: any) => [o.content, o]));
    expect(byContent['Written on A']).toMatchObject({ author: 'A', mine: true });
    expect(byContent['Written on B']).toMatchObject({ author: 'B', mine: false });
    const seenByB = (await post('/v1/search', { projectId, query: 'written' }, machineB)).json.observations;
    expect(seenByB.find((o: any) => o.content === 'Written on A').mine).toBe(false);
  });

  it('filters by author: mine, others, or a label', async () => {
    await post('/v1/memories', { projectId, content: 'Deploy notes from A' });
    await post('/v1/memories', { projectId, content: 'Deploy notes from B' }, machineB);
    const titles = async (author: string, key = teamKey) =>
      (await post('/v1/search', { projectId, query: 'deploy', author }, key)).json.observations.map((o: any) => o.content);
    expect(await titles('mine')).toEqual(['Deploy notes from A']);
    expect(await titles('others')).toEqual(['Deploy notes from B']);
    expect(await titles('b')).toEqual(['Deploy notes from B']);
    expect(await titles('nobody')).toEqual([]);
  });

  it('gives the asking machine most of a SessionStart window', async () => {
    for (let i = 0; i < 10; i++) await post('/v1/memories', { projectId, content: `A note ${i}` });
    for (let i = 0; i < 10; i++) await post('/v1/memories', { projectId, content: `B note ${i}` }, machineB);
    const window = (await post('/v1/context', { projectId, limit: 10, preferOwn: true })).json.observations;
    expect(window.filter((o: any) => o.mine).length).toBe(7);
    expect(window.filter((o: any) => o.mine === false).length).toBe(3);
    // Without the preference the newest ten win, all B's.
    const plain = (await post('/v1/context', { projectId, limit: 10 })).json.observations;
    expect(plain.every((o: any) => o.author === 'B')).toBe(true);
  });

  it('keeps each machine its own to-do lists', async () => {
    await post('/v1/work-state/entries', { projectId, list: 'todo', fields: { task: 'A task', status: 'todo' } });
    await post('/v1/work-state/entries', { projectId, list: 'todo', fields: { task: 'B task', status: 'todo' } }, machineB);
    const tasks = async (key: string) => (await post('/v1/work-state/read', { projectId }, key)).json.entries.map((e: any) => e.fields.task);
    expect(await tasks(teamKey)).toEqual(['A task']);
    expect(await tasks(machineB)).toEqual(['B task']);
  });

  it('imports history with original times, the importing machine as author, once', async () => {
    const items = [
      { key: 'db:observations:1', kind: 'bugfix', content: 'Old fix', metadata: { title: 'Old fix' }, createdAtEpoch: 1_778_430_786_769 },
      { key: 'db:session_summaries:1', kind: 'summary', content: 'Request: old', metadata: { request: 'old' }, createdAtEpoch: 1_778_430_900_000 },
    ];
    const first = await post('/v1/import/observations', { projectId: 'name:imported', items }, machineB);
    expect(first.json).toEqual({ inserted: 2, existing: 0 });
    expect((await post('/v1/import/observations', { projectId: 'name:imported', items }, machineB)).json).toEqual({ inserted: 0, existing: 2 });
    const rows = (await post('/v1/search', { projectId: 'name:imported', orderBy: 'date_asc', category: 'all', author: 'b' })).json.observations;
    expect(rows.map((o: any) => [o.content, o.createdAtEpoch, o.author, o.metadata.project, o.metadata.imported]))
      .toEqual([['Old fix', 1_778_430_786_769, 'B', 'imported', true], ['Request: old', 1_778_430_900_000, 'B', 'imported', true]]);
  });
});
