// SPDX-License-Identifier: Apache-2.0
//
// The worker's read surface on the server: search filters, order and paging;
// timeline by query, time or short ref; selected rows by short ref and in date
// order; raw tool calls by observation id or tool_use_id, and the deep search;
// several projects at once; the team's project list.
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
import { PostgresObservationSourcesRepository } from '../../src/storage/postgres/observations.js';
import { newApiKey, createIsolatedSchema, dropSchema } from '../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('server read parity routes', () => {
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
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_parity_routes');
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

  async function teamOf(id = projectId): Promise<string> {
    return (await client.query<{ team_id: string }>('SELECT team_id FROM projects WHERE id = $1', [id])).rows[0]!.team_id;
  }

  async function observe(content: string, options: { kind?: string; at: string; project?: string; inProject?: string; metadata?: Record<string, unknown> }) {
    const storage = createPostgresStorageRepositories(client);
    const target = options.inProject ?? projectId;
    const row = await storage.observations.create({
      projectId: target, teamId: await teamOf(target), kind: options.kind ?? 'discovery', content,
      metadata: { title: content, project: options.project ?? 'repo', ...options.metadata },
    });
    await client.query('UPDATE observations SET created_at = $2 WHERE id = $1', [row.id, options.at]);
    return row;
  }

  it('searches with filters, date order and paging, and without a query', async () => {
    await observe('Deploy pipeline fixed', { kind: 'bugfix', at: '2026-01-10T10:00:00Z' });
    await observe('Deploy notes written', { kind: 'discovery', at: '2026-02-10T10:00:00Z' });
    await observe('Deploy session summary', { kind: 'summary', at: '2026-03-10T10:00:00Z' });
    const titles = (json: any) => json.observations.map((o: any) => o.content);

    const byDate = await post('/v1/search', { projectId, query: 'deploy', orderBy: 'date_asc' });
    expect(titles(byDate.json)).toEqual(['Deploy pipeline fixed', 'Deploy notes written', 'Deploy session summary']);
    const page = await post('/v1/search', { projectId, query: 'deploy', orderBy: 'date_desc', limit: 1, offset: 1 });
    expect(titles(page.json)).toEqual(['Deploy notes written']);
    const ranged = await post('/v1/search', { projectId, query: 'deploy', dateStart: '2026-02-01', dateEnd: '2026-02-28' });
    expect(titles(ranged.json)).toEqual(['Deploy notes written']);
    const typed = await post('/v1/search', { projectId, observationTypes: ['bugfix'] });
    expect(titles(typed.json)).toEqual(['Deploy pipeline fixed']);
    const sessions = await post('/v1/search', { projectId, category: 'sessions' });
    expect(titles(sessions.json)).toEqual(['Deploy session summary']);
    expect((await post('/v1/search', { projectId, category: 'prompts' })).json.observations).toEqual([]);
    expect((await post('/v1/search', { projectId })).status).toBe(400);
    expect((await post('/v1/search', { projectId, query: 'x', dateStart: 'not a date' })).status).toBe(400);
  });

  it('builds a timeline from a query, a moment or a short ref', async () => {
    const first = await observe('Alpha step', { at: '2026-01-01T00:00:00Z' });
    await observe('Beta step', { at: '2026-01-02T00:00:00Z' });
    await observe('Gamma step', { at: '2026-01-03T00:00:00Z' });
    const titles = (json: any) => json.observations.map((o: any) => o.content);
    const byQuery = await post('/v1/timeline', { projectId, query: 'gamma', depthBefore: 1, depthAfter: 0 });
    expect(titles(byQuery.json)).toEqual(['Beta step', 'Gamma step']);
    const byTime = await post('/v1/timeline', { projectId, anchorTime: '2026-01-02T12:00:00Z', depthBefore: 1, depthAfter: 1 });
    expect(titles(byTime.json)).toEqual(['Beta step', 'Gamma step']);
    const byShortRef = await post('/v1/timeline', { projectId, anchorId: first.id.slice(0, 8), depthBefore: 0, depthAfter: 1 });
    expect(titles(byShortRef.json)).toEqual(['Alpha step', 'Beta step']);
    expect((await post('/v1/timeline', { projectId, anchorId: first.id, query: 'x' })).status).toBe(400);
  });

  it('fetches selected rows by full id or short ref, in date order when asked', async () => {
    const a = await observe('Older', { at: '2026-01-01T00:00:00Z' });
    const b = await observe('Newer', { at: '2026-01-05T00:00:00Z' });
    const inOrder = await post('/v1/observations/batch', { projectId, ids: [a.id.slice(0, 8), b.id] });
    expect(inOrder.json.observations.map((o: any) => o.content)).toEqual(['Older', 'Newer']);
    const newest = await post('/v1/observations/batch', { projectId, ids: [a.id, b.id], orderBy: 'date_desc', limit: 1 });
    expect(newest.json.observations.map((o: any) => o.content)).toEqual(['Newer']);
  });

  it('reads several projects at once by name, and lists the team projects', async () => {
    const storage = createPostgresStorageRepositories(client);
    const team = await teamOf();
    const parent = await storage.projects.create({ teamId: team, name: 'mono' });
    await observe('Parent decision', { at: '2026-01-01T00:00:00Z', inProject: parent.id, project: 'mono' });
    await observe('Worktree change', { at: '2026-01-02T00:00:00Z', project: 'repo' });
    const both = await post('/v1/context', { projectId, projectIds: ['name:repo', 'name:mono', 'name:missing'], limit: 10 });
    expect(both.json.observations.map((o: any) => o.content).sort()).toEqual(['Parent decision', 'Worktree change']);
    const search = await post('/v1/search', { projectId, projectIds: ['name:repo', 'name:mono'], query: 'decision' });
    expect(search.json.observations.map((o: any) => o.content)).toEqual(['Parent decision']);
    const listed = await fetch(`http://127.0.0.1:${port}/v1/projects`, { headers: { Authorization: `Bearer ${teamKey}` } });
    const names = ((await listed.json()) as any).projects.map((p: any) => p.name);
    expect(names).toEqual(expect.arrayContaining(['repo', 'mono', 'side']));
    const scoped = await fetch(`http://127.0.0.1:${port}/v1/projects`, { headers: { Authorization: `Bearer ${projectScopedKey}` } });
    expect(((await scoped.json()) as any).projects.map((p: any) => p.name)).toEqual(['side']);
  });

  it('returns raw tool calls by observation id or tool_use_id, and finds them by content', async () => {
    const storage = createPostgresStorageRepositories(client);
    const team = await teamOf();
    const event = await storage.agentEvents.create({
      projectId, teamId: team, sourceAdapter: 'api', eventType: 'tool_use', occurredAt: Date.now(),
      payload: { tool_name: 'Bash', tool_use_id: 'toolu_42', tool_input: { command: 'grep -rn zebracorn src' }, tool_response: 'src/a.ts: zebracorn' },
    });
    const obs = await observe('Searched for the marker', { at: '2026-01-01T00:00:00Z' });
    await new PostgresObservationSourcesRepository(client).addSource({
      observationId: obs.id, projectId, teamId: team, sourceType: 'agent_event', sourceId: event.id, agentEventId: event.id,
    });
    const byObservation = await post('/v1/tool-uses/batch', { projectId, ids: [obs.id] });
    expect(byObservation.json.toolUses.map((u: any) => u.tool_name)).toEqual(['Bash']);
    expect(byObservation.json.toolUses[0].observation_id).toBe(obs.id);
    const byToolUseId = await post('/v1/tool-uses/batch', { projectId, ids: ['toolu_42'] });
    expect(byToolUseId.json.toolUses[0].tool_input).toContain('zebracorn');
    const deep = await post('/v1/tool-uses/search', { projectId, query: 'zebracorn grep' });
    expect(deep.json.toolUses.map((u: any) => u.tool_use_id)).toEqual(['toolu_42']);
    expect((await post('/v1/tool-uses/batch', { projectId, ids: [obs.id] }, otherTeamKey)).json.toolUses ?? []).toEqual([]);
  });
});
