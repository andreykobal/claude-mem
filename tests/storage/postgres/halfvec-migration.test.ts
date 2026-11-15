// SPDX-License-Identifier: Apache-2.0
//
// Vectors are stored at half precision (halfvec): half the disk for the
// table and its HNSW index. A database from before that keeps its vectors:
// the bootstrap converts the column in place and rebuilds the index.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { bootstrapServerPostgresSchema } from '../../../src/storage/postgres/index.js';
import { createIsolatedSchema, dropSchema, pgvectorAvailable } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const vectorAvailable = testDatabaseUrl ? await pgvectorAvailable(testDatabaseUrl) : false;

describe.skipIf(!vectorAvailable)('observation vectors at half precision', () => {
  let schemaName: string;
  let pool: pg.Pool;

  beforeEach(async () => {
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_halfvec');
    pool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName},public` });
  });

  afterEach(async () => {
    await pool.end();
    await dropSchema(testDatabaseUrl!, schemaName);
  });

  const columnType = async () => (await pool.query<{ type: string }>(
    `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
     WHERE attrelid = to_regclass('observation_embeddings') AND attname = 'embedding'`,
  )).rows[0]?.type;

  it('creates a new store with halfvec and a halfvec HNSW index', async () => {
    await bootstrapServerPostgresSchema(pool, 'on');
    expect(await columnType()).toBe('halfvec(384)');
    const index = await pool.query<{ def: string }>(`SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'idx_observation_embeddings_hnsw'`);
    expect(index.rows[0]?.def).toContain('halfvec_cosine_ops');
  });

  it('converts a store of full-precision vectors in place, keeping them', async () => {
    await bootstrapServerPostgresSchema(pool, 'on');
    // A store from before: full-precision column and index, one stored vector.
    await pool.query('DROP INDEX idx_observation_embeddings_hnsw');
    await pool.query('ALTER TABLE observation_embeddings ALTER COLUMN embedding TYPE vector(384) USING embedding::vector(384)');
    await pool.query('CREATE INDEX idx_observation_embeddings_hnsw ON observation_embeddings USING hnsw (embedding vector_cosine_ops)');
    await pool.query(`INSERT INTO teams (id, name) VALUES ('t', 't')`);
    await pool.query(`INSERT INTO projects (id, team_id, name) VALUES ('p', 't', 'p')`);
    await pool.query(`INSERT INTO observations (id, project_id, team_id, content) VALUES ('o', 'p', 't', 'x')`);
    await pool.query(
      `INSERT INTO observation_embeddings (observation_id, project_id, team_id, part, model, embedding)
       VALUES ('o', 'p', 't', 'narrative', 'm', ('[0.25,' || array_to_string(array_fill(0, ARRAY[383]), ',') || ']')::vector)`,
    );
    expect(await columnType()).toBe('vector(384)');

    await bootstrapServerPostgresSchema(pool, 'on');

    expect(await columnType()).toBe('halfvec(384)');
    const kept = await pool.query<{ first: number }>(`SELECT (embedding::real[])[1] AS first FROM observation_embeddings WHERE observation_id = 'o'`);
    expect(kept.rows[0]?.first).toBe(0.25);
    const index = await pool.query<{ def: string }>(`SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'idx_observation_embeddings_hnsw'`);
    expect(index.rows[0]?.def).toContain('halfvec_cosine_ops');
  });
});
