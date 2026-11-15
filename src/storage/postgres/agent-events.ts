// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, JsonValue, PostgresQueryable } from './utils.js';
import {
  assertProjectOwnership,
  assertSessionOwnership,
  canonicalJson,
  deterministicKey,
  newId,
  queryOne,
  toEpoch,
  toJsonObject,
  toPostgresJson
} from './utils.js';
import { normalizePlatformSourceOrNull } from '../../shared/platform-source.js';
import { redactJsonStrings } from '../../utils/redaction.js';
import { stripMemoryTagsFromJsonStrings } from '../../utils/tag-stripping.js';

export interface PostgresAgentEvent {
  id: string;
  projectId: string;
  teamId: string;
  serverSessionId: string | null;
  sourceAdapter: string;
  sourceEventId: string | null;
  idempotencyKey: string;
  eventType: string;
  platformSource: string | null;
  payload: JsonValue;
  metadata: JsonObject;
  occurredAtEpoch: number;
  receivedAtEpoch: number;
  createdAtEpoch: number;
}

export interface CreatePostgresAgentEventInput {
  id?: string;
  projectId: string;
  teamId: string;
  serverSessionId?: string | null;
  contentSessionId?: string | null;
  sourceAdapter: string;
  sourceEventId?: string | null;
  eventType: string;
  // #2560 — which platform produced the event (claude-code, opencode, ...).
  // Persisted on agent_events for plan-09 scoping. Optional; null when unknown.
  platformSource?: string | null;
  payload?: JsonValue;
  metadata?: JsonObject;
  occurredAt: Date | string | number;
}

interface AgentEventRow {
  id: string;
  project_id: string;
  team_id: string;
  server_session_id: string | null;
  source_adapter: string;
  source_event_id: string | null;
  idempotency_key: string;
  event_type: string;
  platform_source: string | null;
  payload: unknown;
  metadata: unknown;
  occurred_at: Date;
  received_at: Date;
  created_at: Date;
}

export class PostgresAgentEventsRepository {
  constructor(private client: PostgresQueryable) {}

  async create(input: CreatePostgresAgentEventInput): Promise<PostgresAgentEvent> {
    await assertProjectOwnership(this.client, input.projectId, input.teamId);
    if (input.serverSessionId) {
      await assertSessionOwnership(this.client, input.serverSessionId, input.projectId, input.teamId);
    }
    const idempotencyKey = buildAgentEventIdempotencyKey(input);
    const platformSource = normalizePlatformSourceOrNull(input.platformSource);
    const row = await queryOne<AgentEventRow>(
      this.client,
      `
        INSERT INTO agent_events (
          id, project_id, team_id, server_session_id, source_adapter,
          source_event_id, idempotency_key, event_type, platform_source, payload, metadata, occurred_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
        ON CONFLICT (idempotency_key) DO UPDATE SET
          server_session_id = COALESCE(agent_events.server_session_id, excluded.server_session_id),
          metadata = agent_events.metadata || excluded.metadata,
          platform_source = COALESCE(excluded.platform_source, agent_events.platform_source)
        RETURNING *
      `,
      [
        input.id ?? newId(),
        input.projectId,
        input.teamId,
        input.serverSessionId ?? null,
        input.sourceAdapter,
        input.sourceEventId ?? null,
        idempotencyKey,
        input.eventType,
        platformSource,
        // <private> sections are removed and opt-in secret redaction (#2616)
        // applied to the raw event body, at the one write every ingest path
        // goes through, so a client that did not strip still stores none.
        toPostgresJson(redactJsonStrings(stripMemoryTagsFromJsonStrings(input.payload ?? {}))),
        toPostgresJson(redactJsonStrings(stripMemoryTagsFromJsonStrings(input.metadata ?? {}))),
        new Date(input.occurredAt)
      ]
    );
    return mapAgentEventRow(row!);
  }

  async getByIdForScope(input: {
    id: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresAgentEvent | null> {
    const row = await queryOne<AgentEventRow>(
      this.client,
      'SELECT * FROM agent_events WHERE id = $1 AND project_id = $2 AND team_id = $3',
      [input.id, input.projectId, input.teamId]
    );
    return row ? mapAgentEventRow(row) : null;
  }

  async listByProject(input: {
    projectId: string;
    teamId: string;
    serverSessionId?: string | null;
    limit?: number;
  }): Promise<PostgresAgentEvent[]> {
    const result = await this.client.query<AgentEventRow>(
      `
        SELECT * FROM agent_events
        WHERE project_id = $1
          AND team_id = $2
          AND ($3::text IS NULL OR server_session_id = $3)
        ORDER BY occurred_at DESC
        LIMIT $4
      `,
      [input.projectId, input.teamId, input.serverSessionId ?? null, input.limit ?? 100]
    );
    return result.rows.map(mapAgentEventRow);
  }
}

export function buildAgentEventIdempotencyKey(input: {
  teamId: string;
  projectId: string;
  sourceAdapter: string;
  sourceEventId?: string | null;
  serverSessionId?: string | null;
  contentSessionId?: string | null;
  eventType: string;
  platformSource?: string | null;
  occurredAt: Date | string | number;
  payload?: JsonValue;
}): string {
  const platformSource = normalizePlatformSourceOrNull(input.platformSource);
  const platformScope = platformSource ? [platformSource] : [];

  if (input.sourceEventId) {
    return `agent_event:v1:${deterministicKey([
      input.teamId,
      input.projectId,
      input.sourceAdapter,
      ...platformScope,
      input.sourceEventId
    ])}`;
  }

  // Use contentSessionId (stable, client-provided) over serverSessionId, which is
  // resolved lazily at ingest and can be NULL on a first delivery but non-NULL on a
  // retry — that would drift the key and create duplicate events. Falls back to
  // serverSessionId for events that don't carry a contentSessionId.
  return `agent_event:v1:${deterministicKey([
    input.teamId,
    input.projectId,
    input.sourceAdapter,
    ...platformScope,
    input.contentSessionId ?? input.serverSessionId ?? null,
    input.eventType,
    new Date(input.occurredAt).toISOString(),
    canonicalJson(input.payload ?? {})
  ])}`;
}

function mapAgentEventRow(row: AgentEventRow): PostgresAgentEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    teamId: row.team_id,
    serverSessionId: row.server_session_id,
    sourceAdapter: row.source_adapter,
    sourceEventId: row.source_event_id,
    idempotencyKey: row.idempotency_key,
    eventType: row.event_type,
    platformSource: row.platform_source,
    payload: row.payload,
    metadata: toJsonObject(row.metadata),
    occurredAtEpoch: toEpoch(row.occurred_at),
    receivedAtEpoch: toEpoch(row.received_at),
    createdAtEpoch: toEpoch(row.created_at)
  };
}

/** One tool call's raw input and output, as get_tool_uses shows it. */
export interface PostgresToolUse {
  id: string;
  tool_use_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  platform_source: string | null;
  content_session_id: string | null;
  observation_id: string | null;
  created_at_epoch: number;
}

/** A raw payload is clipped at the worker's MAX_TOOL_PAYLOAD_BYTES, with the same marker. */
export const TOOL_USE_PAYLOAD_MAX_BYTES = 64 * 1024;

function clipPayload(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= TOOL_USE_PAYLOAD_MAX_BYTES) return text;
  return `${Buffer.from(text, 'utf8').subarray(0, TOOL_USE_PAYLOAD_MAX_BYTES).toString('utf8')}…[truncated: ${bytes} bytes]`;
}

/**
 * search(deep): tool calls whose raw input or output contains every query
 * term, newest first, when the observations found nothing (the worker's
 * tool_uses_fts fallback). Terms are matched as literal substrings.
 */
export async function searchToolUsesForScope(
  client: PostgresQueryable,
  input: { projectIds: string[]; teamId: string; query: string; limit: number; platformSource?: string | null },
): Promise<PostgresToolUse[]> {
  const terms = [...new Set(input.query.toLowerCase().split(/\s+/).filter(term => term.length >= 2))].slice(0, 8);
  if (terms.length === 0) return [];
  const patterns = terms.map(term => `%${term.replace(/[\\%_]/g, character => `\\${character}`)}%`);
  const result = await client.query<{ id: string }>(
    `SELECT e.id FROM agent_events e
     WHERE e.project_id = ANY($1::text[]) AND e.team_id = $2 AND e.event_type = 'tool_use'
       AND ($4::text IS NULL OR e.platform_source = $4)
       AND lower(e.payload::text) LIKE ALL($3::text[])
     ORDER BY e.occurred_at DESC, e.id DESC
     LIMIT $5`,
    [input.projectIds, input.teamId, patterns, input.platformSource ?? null, input.limit],
  );
  const ids = result.rows.map(row => row.id);
  if (ids.length === 0) return [];
  const rows: PostgresToolUse[] = [];
  for (const projectId of input.projectIds) {
    rows.push(...await listToolUsesForScope(client, { projectId, teamId: input.teamId, ids, limit: input.limit }));
  }
  return rows.sort((a, b) => b.created_at_epoch - a.created_at_epoch).slice(0, input.limit);
}

/**
 * Tool calls in the caller's scope, by event id, by the host's tool_use_id, or
 * by an observation they produced (observation_sources), oldest first.
 */
export async function listToolUsesForScope(
  client: PostgresQueryable,
  input: { projectId: string; teamId: string; ids: string[]; limit: number; contentSessionId?: string | null; platformSource?: string | null },
): Promise<PostgresToolUse[]> {
  if (input.ids.length === 0) return [];
  const result = await client.query<{
    id: string; payload: Record<string, unknown> | null; platform_source: string | null;
    content_session_id: string | null; observation_id: string | null; occurred_at: Date;
  }>(
    `SELECT DISTINCT ON (e.occurred_at, e.id)
       e.id, e.payload, e.platform_source, e.occurred_at,
       COALESCE(NULLIF(s.content_session_id, ''), s.external_session_id) AS content_session_id,
       os.observation_id
     FROM agent_events e
     LEFT JOIN server_sessions s
       ON s.id = e.server_session_id AND s.project_id = e.project_id AND s.team_id = e.team_id
     LEFT JOIN observation_sources os
       ON os.agent_event_id = e.id AND os.source_type = 'agent_event'
     WHERE e.project_id = $1 AND e.team_id = $2 AND e.event_type = 'tool_use'
       AND (e.id = ANY($3::text[]) OR e.payload->>'tool_use_id' = ANY($3::text[]) OR os.observation_id = ANY($3::text[]))
       AND ($4::text IS NULL OR s.content_session_id = $4 OR s.external_session_id = $4)
       AND ($5::text IS NULL OR e.platform_source = $5)
     ORDER BY e.occurred_at, e.id
     LIMIT $6`,
    [input.projectId, input.teamId, input.ids, input.contentSessionId ?? null, input.platformSource ?? null, input.limit],
  );
  return result.rows.map(row => {
    const payload = row.payload ?? {};
    return {
      id: row.id,
      tool_use_id: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null,
      tool_name: typeof payload.tool_name === 'string' ? payload.tool_name : null,
      tool_input: clipPayload(payload.tool_input),
      tool_response: clipPayload(payload.tool_response),
      cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
      platform_source: row.platform_source,
      content_session_id: row.content_session_id,
      observation_id: row.observation_id,
      created_at_epoch: toEpoch(row.occurred_at),
    };
  });
}
