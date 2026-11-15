// SPDX-License-Identifier: Apache-2.0
//
// A tool output can carry NUL (binary read as text). jsonb cannot hold it
// ("unsupported Unicode escape sequence"), and the whole event insert failed,
// losing the event. It is stored without the NUL instead.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  toPostgresJson,
} from '../../../src/storage/postgres/index.js';
import { createIsolatedSchema, dropSchema } from '../../sdk/pg-isolation.js';

describe('toPostgresJson', () => {
  it('removes NUL from strings and keys, leaving other text alone', () => {
    expect(JSON.parse(toPostgresJson({ 'k\u0000ey': ['a\u0000b', { c: 'd\u0000' }], n: 1, t: 'ü\\u0000' })))
      .toEqual({ key: ['ab', { c: 'd' }], n: 1, t: 'ü\\u0000' });
  });
});

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('agent event with NUL in its payload', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }
  let pool: pg.Pool;
  let schemaName: string;

  beforeEach(async () => {
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_event_nul');
    pool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName},public` });
    await bootstrapServerPostgresSchema(pool, 'off');
  });

  afterEach(async () => {
    await pool.end();
    await dropSchema(testDatabaseUrl!, schemaName);
  });

  it('is stored, without the NUL', async () => {
    const storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    const event = await storage.agentEvents.create({
      projectId: project.id,
      teamId: team.id,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: { tool_response: 'binary\u0000output' },
      occurredAt: Date.now(),
    });
    expect((event.payload as { tool_response: string }).tool_response).toBe('binaryoutput');
  });

  it('stores an image a tool returned as a marker, from any client', async () => {
    const storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    const event = await storage.agentEvents.create({
      projectId: project.id,
      teamId: team.id,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: { tool_response: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' + 'Bc7y'.repeat(1500) } }] },
      occurredAt: Date.now(),
    });
    expect(JSON.stringify(event.payload)).toContain('[image/jpeg 4 KB omitted]');
    expect(JSON.stringify(event.payload)).not.toContain('Bc7yBc7yBc7y');
  });
});
