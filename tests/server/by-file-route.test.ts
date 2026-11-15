// SPDX-License-Identifier: Apache-2.0
//
// /v1/observations/by-file: the file-context hook's history in server runtime,
// matched on any stored spelling of the path in files_read/files_modified.
// /v1/memories labels a note with its project, so SessionStart's folder scope
// shows it.
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
import { newApiKey, createIsolatedSchema, dropSchema } from '../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('/v1/observations/by-file and labelled memories', () => {
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
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_by_file');
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

  async function post(path: string, body: Record<string, unknown>, key = teamKey): Promise<{ status: number; json: any }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  }

  async function observe(content: string, metadata: Record<string, unknown>) {
    const storage = createPostgresStorageRepositories(client);
    const team = (await client.query<{ team_id: string }>('SELECT team_id FROM projects WHERE id = $1', [projectId])).rows[0]!.team_id;
    return storage.observations.create({ projectId, teamId: team, kind: 'bugfix', content, metadata });
  }

  it('finds observations by any stored spelling of the path, newest first', async () => {
    await observe('Read the parser', { project: 'repo', files_read: ['/home/a/repo/src/parser.ts'] });
    await observe('Fixed the parser', { project: 'repo', files_modified: ['src\\parser.ts'] });
    await observe('Unrelated', { project: 'repo', files_read: ['src/other.ts'] });
    const found = await post('/v1/observations/by-file', { projectId, paths: ['/home/a/repo/src/parser.ts', 'src/parser.ts'] });
    expect(found.status).toBe(200);
    expect(found.json.observations.map((o: any) => o.content)).toEqual(['Fixed the parser', 'Read the parser']);
    const scoped = await post('/v1/observations/by-file', { projectId, paths: ['src/parser.ts'], folderProjects: ['other-folder'] });
    expect(scoped.json.observations).toEqual([]);
    expect((await post('/v1/observations/by-file', { projectId, paths: ['src/parser.ts'] }, otherTeamKey)).json.observations ?? []).toEqual([]);
  });

  it('labels a note written without a folder label with its project name', async () => {
    const saved = await post('/v1/memories', { projectId, content: 'A note' });
    expect(saved.status).toBe(201);
    expect(saved.json.memory.metadata.project).toBe('repo');
    const named = await post('/v1/memories', { projectId, content: 'Another', metadata: { project: 'sub' } });
    expect(named.json.memory.metadata.project).toBe('sub');
  });
});
