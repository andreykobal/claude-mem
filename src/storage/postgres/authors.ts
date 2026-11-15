// SPDX-License-Identifier: Apache-2.0

import type { PostgresQueryable } from './utils.js';

/**
 * Authors are API keys: one key per machine, labelled (A, B, C...). A row
 * carries its writing key (author_key_id) and, for display, the key's label
 * (metadata.author) as it was when written.
 */

const LABEL_CACHE_MS = 60_000;
const cache = new Map<string, { label: string | null; at: number }>();

/** The key's label, or null for a key without one (or no key: local dev). */
export async function authorLabel(client: PostgresQueryable, keyId: string | null | undefined): Promise<string | null> {
  if (!keyId) return null;
  const hit = cache.get(keyId);
  if (hit && Date.now() - hit.at < LABEL_CACHE_MS) return hit.label;
  const result = await client.query<{ label: string | null }>('SELECT label FROM api_keys WHERE id = $1', [keyId]);
  const label = result.rows[0]?.label?.trim() || null;
  cache.set(keyId, { label, at: Date.now() });
  return label;
}

/** Set a key's label (the `server api-key label` command). */
export async function setAuthorLabel(client: PostgresQueryable, keyId: string, label: string | null): Promise<boolean> {
  const result = await client.query('UPDATE api_keys SET label = $2, updated_at = now() WHERE id = $1', [keyId, label]);
  cache.delete(keyId);
  return (result.rowCount ?? 0) > 0;
}
