/**
 * Inline binary (an image a tool returned, a pasted screenshot, a data: URI)
 * as a short marker. In server runtime there is no local media store to move
 * images into, so a base64 body reached the server as text: up to 5 MB per
 * event in Postgres, into the observer's prompt (spending the plan on noise
 * the model may copy into an observation), and back out through
 * get_tool_uses. The marker keeps that an image was there and its size.
 */

// A data: URI with a base64 body, any length.
const DATA_URI = /data:([a-z]+\/[a-z0-9.+-]+)?;base64,[A-Za-z0-9+/]+={0,2}/gi;
// A bare base64 run long enough to be binary, not a hash, key or identifier:
// those are far shorter, and code or prose breaks such a run within lines.
const BARE_BASE64 = /[A-Za-z0-9+/]{1000,}={0,2}/g;

function size(encodedLength: number): string {
  const bytes = Math.floor(encodedLength * 3 / 4);
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Encoded binary mixes upper case, lower case and digits throughout; a run of
 * one letter, or of letters only, is filler or text, not an image body.
 */
function looksEncoded(run: string): boolean {
  return /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run);
}

/** The text with every inline binary body replaced by a marker. */
export function stripInlineBinary(text: string): string {
  if (text.length < 100) return text;
  return text
    .replace(DATA_URI, (match, mime: string | undefined) => `[${mime ?? 'binary'} ${size(match.length)} omitted]`)
    .replace(BARE_BASE64, match => looksEncoded(match) ? `[binary ${size(match.length)} omitted]` : match);
}

/**
 * Every string in the value stripped, and an image content block
 * ({type: 'image', source: {type: 'base64', media_type, data}}) reduced to a
 * marker, structure otherwise kept.
 */
export function stripInlineBinaryDeep<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return stripInlineBinary(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      const source = record.source as Record<string, unknown> | undefined;
      if (record.type === 'image' && source && typeof source.data === 'string') {
        const mime = typeof source.media_type === 'string' ? source.media_type : 'image';
        return { type: 'text', text: `[${mime} ${size(source.data.length)} omitted]` };
      }
      return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  return walk(value) as T;
}
