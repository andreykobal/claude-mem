// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, PostgresQueryable } from './utils.js';
import { newId, queryOne, toEpoch, toJsonObject } from './utils.js';
import { withPostgresTransaction, type PostgresPool } from './pool.js';

export interface PostgresProject {
  id: string;
  teamId: string;
  name: string;
  metadata: JsonObject;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

interface ProjectRow {
  id: string;
  team_id: string;
  name: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export class PostgresProjectsRepository {
  constructor(private client: PostgresQueryable) {}

  async create(input: {
    id?: string;
    teamId: string;
    name: string;
    metadata?: JsonObject;
  }): Promise<PostgresProject> {
    const id = input.id ?? newId();
    const row = await queryOne<ProjectRow>(
      this.client,
      `
        INSERT INTO projects (id, team_id, name, metadata)
        VALUES ($1, $2, $3, $4::jsonb)
        RETURNING *
      `,
      [id, input.teamId, input.name, JSON.stringify(input.metadata ?? {})]
    );
    return mapProjectRow(row!);
  }

  /** The team's oldest project with this name, if any (names are not unique in the schema). */
  async getByNameForTeam(name: string, teamId: string): Promise<PostgresProject | null> {
    const row = await queryOne<ProjectRow>(
      this.client,
      'SELECT * FROM projects WHERE team_id = $1 AND name = $2 ORDER BY created_at ASC, id ASC LIMIT 1',
      [teamId, name]
    );
    return row ? mapProjectRow(row) : null;
  }

  async getByIdForTeam(id: string, teamId: string): Promise<PostgresProject | null> {
    const row = await queryOne<ProjectRow>(
      this.client,
      'SELECT * FROM projects WHERE id = $1 AND team_id = $2',
      [id, teamId]
    );
    return row ? mapProjectRow(row) : null;
  }
}

/**
 * Find the team's project by name, creating it when absent. A transaction-
 * scoped advisory lock on (team, name) serializes concurrent first writes, so
 * two hooks naming a new project at once still produce one row.
 */
export async function getOrCreateProjectByName(
  pool: PostgresPool,
  input: { teamId: string; name: string },
): Promise<PostgresProject> {
  const existing = await new PostgresProjectsRepository(pool).getByNameForTeam(input.name, input.teamId);
  if (existing) return existing;
  return withPostgresTransaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`project-name:${input.teamId}:${input.name}`]);
    const repo = new PostgresProjectsRepository(client);
    const raced = await repo.getByNameForTeam(input.name, input.teamId);
    if (raced) return raced;
    return repo.create({ teamId: input.teamId, name: input.name, metadata: { createdBy: 'project-name-resolver' } });
  });
}

function mapProjectRow(row: ProjectRow): PostgresProject {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    metadata: toJsonObject(row.metadata),
    createdAtEpoch: toEpoch(row.created_at),
    updatedAtEpoch: toEpoch(row.updated_at)
  };
}
