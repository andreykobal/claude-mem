// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  parseProjectNameRef,
  projectNameResolver,
} from '../../../src/server/middleware/project-name-resolver.js';

interface Row { id: string; team_id: string; name: string; metadata: unknown; created_at: Date; updated_at: Date }

/** Minimal in-memory stand-in for the pg Pool calls the resolver makes. */
function fakePool(seed: Row[] = []) {
  const rows = [...seed];
  let nextId = 1;
  const query = async (sql: string, params: unknown[] = []) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('SELECT * FROM projects WHERE team_id = $1 AND name = $2')) {
      const [teamId, name] = params as [string, string];
      return { rows: rows.filter(r => r.team_id === teamId && r.name === name).slice(0, 1) };
    }
    if (sql.includes('INSERT INTO projects')) {
      const [id, teamId, name, metadata] = params as [string, string, string, string];
      const row: Row = { id: id ?? `p${nextId++}`, team_id: teamId, name, metadata: JSON.parse(metadata), created_at: new Date(), updated_at: new Date() };
      rows.push(row);
      return { rows: [row] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
  };
  return { pool: pool as any, rows };
}

function run(handler: ReturnType<typeof projectNameResolver>, req: any) {
  return new Promise<{ nextCalled: boolean; status?: number; body?: unknown }>(resolve => {
    const res: any = {
      status(code: number) { this.code = code; return this; },
      json(body: unknown) { resolve({ nextCalled: false, status: this.code, body }); },
    };
    handler(req, res, () => resolve({ nextCalled: true }));
  });
}

const auth = (overrides: Record<string, unknown> = {}) => ({
  teamId: 'team-1', projectId: null, scopes: ['memories:read', 'memories:write'], apiKeyId: 'k', userId: null, organizationId: null, mode: 'api-key', ...overrides,
});

describe('parseProjectNameRef', () => {
  it('reads only name: references', () => {
    expect(parseProjectNameRef('name:claude-mem')).toBe('claude-mem');
    expect(parseProjectNameRef('8c1f-uuid')).toBeNull();
    expect(parseProjectNameRef(undefined)).toBeNull();
  });
});

describe('projectNameResolver', () => {
  it('leaves an ordinary project id untouched', async () => {
    const { pool } = fakePool();
    const req = { body: { projectId: 'proj-uuid' }, authContext: auth() };
    expect((await run(projectNameResolver(pool, { create: true }), req)).nextCalled).toBe(true);
    expect(req.body.projectId).toBe('proj-uuid');
  });

  it('creates the team project on first write and reuses it after', async () => {
    const { pool, rows } = fakePool();
    const handler = projectNameResolver(pool, { create: true });
    const first = { body: { projectId: 'name:claude-mem' }, authContext: auth() };
    await run(handler, first);
    const second = { body: { projectId: 'name:claude-mem' }, authContext: auth() };
    await run(handler, second);
    expect(rows).toHaveLength(1);
    expect(first.body.projectId).toBe(rows[0]!.id);
    expect(second.body.projectId).toBe(rows[0]!.id);
  });

  it('keeps teams apart', async () => {
    const { pool, rows } = fakePool();
    const handler = projectNameResolver(pool, { create: true });
    await run(handler, { body: { projectId: 'name:app' }, authContext: auth({ teamId: 'team-1' }) });
    await run(handler, { body: { projectId: 'name:app' }, authContext: auth({ teamId: 'team-2' }) });
    expect(rows.map(r => r.team_id).sort()).toEqual(['team-1', 'team-2']);
  });

  it('never creates a project on a read route', async () => {
    const { pool, rows } = fakePool();
    const req = { body: { projectId: 'name:unknown' }, authContext: auth() };
    expect((await run(projectNameResolver(pool, { create: false }), req)).nextCalled).toBe(true);
    expect(rows).toHaveLength(0);
    expect(req.body.projectId).toBe('name:unknown');
  });

  it('never lets a project-scoped key create a project', async () => {
    const { pool, rows } = fakePool();
    const req = { body: { projectId: 'name:other' }, authContext: auth({ projectId: 'proj-key' }) };
    await run(projectNameResolver(pool, { create: true }), req);
    expect(rows).toHaveLength(0);
    // Left unresolved, the route's own scope check refuses it.
    expect(req.body.projectId).toBe('name:other');
  });

  it('rejects an empty or oversized name', async () => {
    const { pool } = fakePool();
    const empty = await run(projectNameResolver(pool, { create: true }), { body: { projectId: 'name:  ' }, authContext: auth() });
    expect(empty.status).toBe(400);
    const long = await run(projectNameResolver(pool, { create: true }), { body: { projectId: `name:${'x'.repeat(201)}` }, authContext: auth() });
    expect(long.status).toBe(400);
  });
});
