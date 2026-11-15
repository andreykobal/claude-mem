// SPDX-License-Identifier: Apache-2.0

import type { QueryResultRow } from 'pg';
import type { PostgresQueryable } from './utils.js';
import { toEpoch } from './utils.js';
import { isSharedWorkList } from '../../services/work-view/shared-records.mjs';
import type { WorkStateFields } from '../../services/sqlite/work-state.js';

/**
 * Server-runtime store for the agent's to-do lists and working state
 * (work_state_write). Append-only, one row per write, read back in write order;
 * folding and rendering stay with the client (WorkStateRenderer), exactly as
 * for rows from the local store.
 */
export interface PostgresWorkStateEntry {
  id: number;
  projectId: string;
  listName: string;
  fields: WorkStateFields;
  createdAtEpoch: number;
}

interface WorkStateRow extends QueryResultRow {
  id: string | number;
  project_id: string;
  list_name: string;
  fields: string;
  created_at: Date;
}

export class PostgresWorkStateRepository {
  constructor(private client: PostgresQueryable) {}

  async append(input: { teamId: string; projectId: string; listName: string; fields: WorkStateFields; authorKeyId?: string | null }): Promise<PostgresWorkStateEntry> {
    const result = await this.client.query<WorkStateRow>(
      `
        INSERT INTO work_state_entries (project_id, team_id, list_name, fields, author_key_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, project_id, list_name, fields, created_at
      `,
      [input.projectId, input.teamId, input.listName, JSON.stringify(input.fields), input.authorKeyId ?? null],
    );
    return mapRow(result.rows[0]!);
  }

  /**
   * Every entry of the project (or of one list), in write order. Each machine
   * keeps its own lists: with `authorKeyId`, that key's rows and rows from
   * before authors. Shared My Work records never leave.
   */
  async list(input: { teamId: string; projectId: string; listName?: string; authorKeyId?: string | null }): Promise<PostgresWorkStateEntry[]> {
    if (input.listName !== undefined && isSharedWorkList(input.listName)) return [];
    const params: unknown[] = [input.teamId, input.projectId, input.authorKeyId ?? null];
    let listFilter = ' AND ($3::text IS NULL OR author_key_id IS NULL OR author_key_id = $3)';
    if (input.listName !== undefined) {
      params.push(input.listName);
      listFilter += ' AND list_name = $4';
    }
    const result = await this.client.query<WorkStateRow>(
      `
        SELECT id, project_id, list_name, fields, created_at
        FROM work_state_entries
        WHERE team_id = $1 AND project_id = $2${listFilter}
        ORDER BY id
      `,
      params,
    );
    return result.rows.filter(row => !isSharedWorkList(row.list_name)).map(mapRow);
  }
}

function mapRow(row: WorkStateRow): PostgresWorkStateEntry {
  return {
    id: Number(row.id),
    projectId: row.project_id,
    listName: row.list_name,
    fields: JSON.parse(row.fields) as WorkStateFields,
    createdAtEpoch: toEpoch(row.created_at),
  };
}
