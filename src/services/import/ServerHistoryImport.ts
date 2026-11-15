import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildServerContext, selectRuntime } from '../hooks/runtime-selector.js';
import { DB_PATH } from '../../shared/paths.js';
import { stripInlineBinary, stripInlineBinaryDeep } from '../../shared/inline-binary.js';

/**
 * `worker-service server-import`: a machine's local history (observations and
 * session summaries in ~/.claude-mem/claude-mem.db) onto the server, run once
 * per machine after it switched to the server runtime.
 *
 * - Read only: the database is copied (with its WAL) and the copy is read.
 * - Rows keep their original times and land under their project's name, as
 *   the hooks name it; worktree rows adopted by a parent go to the parent.
 * - Nothing is generated: rows are stored as they were (POST
 *   /v1/import/observations) and the server computes their vectors.
 * - Rerunnable: each row's key is <database>:<table>:<id>, so a second run
 *   adds only what the first did not.
 * - The importing machine's key is the rows' author.
 */

export interface ImportOptions {
  dbPath: string;
  dryRun: boolean;
  project: string | null;
  batchSize: number;
}

interface ImportItem {
  key: string;
  kind: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAtEpoch: number;
}

const MAX_BATCH = 200;
const RETRIES = 3;

export function parseImportArgs(argv: string[]): ImportOptions {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] && !argv[index + 1]!.startsWith('--') ? argv[index + 1]! : null;
  };
  const batch = Number(value('--batch') ?? MAX_BATCH);
  return {
    dbPath: value('--db') ?? DB_PATH,
    dryRun: argv.includes('--dry-run'),
    project: value('--project'),
    batchSize: Number.isInteger(batch) && batch > 0 ? Math.min(MAX_BATCH, batch) : MAX_BATCH,
  };
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [value];
  } catch {
    return [value];
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Epoch ms; a store that kept seconds is read as seconds. */
function epochMs(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Date.now();
  return number < 1e12 ? Math.round(number * 1000) : Math.round(number);
}

/** The observation as the server's generator renders it (processGeneratedResponse). */
export function observationItem(row: Record<string, unknown>, databaseId: string): ImportItem | null {
  return withoutInlineBinary(observationItemRaw(row, databaseId));
}

/** History written before images were stripped carries base64: it moves as a marker. */
function withoutInlineBinary(item: ImportItem | null): ImportItem | null {
  return item && { ...item, content: stripInlineBinary(item.content), metadata: stripInlineBinaryDeep(item.metadata) };
}

function observationItemRaw(row: Record<string, unknown>, databaseId: string): ImportItem | null {
  const title = text(row.title);
  const subtitle = text(row.subtitle);
  const narrative = text(row.narrative) ?? text(row.text);
  const facts = list(row.facts);
  const concepts = list(row.concepts);
  const parts = [title, subtitle, narrative, facts.length ? facts.map(fact => `- ${fact}`).join('\n') : null].filter(Boolean) as string[];
  if (parts.length === 0 && concepts.length) parts.push(`Concepts: ${concepts.join(', ')}`);
  const content = parts.join('\n\n').trim();
  if (!content) return null;
  const type = text(row.type) ?? 'discovery';
  return {
    key: `${databaseId}:observations:${row.id}`,
    // On the server 'summary' is a session summary; an observation typed so is not one.
    kind: type === 'summary' ? 'discovery' : type,
    content,
    metadata: {
      title, subtitle, narrative, facts, concepts,
      files_read: list(row.files_read),
      files_modified: list(row.files_modified),
      project: row.target_project,
      platformSource: text(row.platform_source) ?? 'claude',
      importedFrom: { table: 'observations', id: row.id },
    },
    createdAtEpoch: epochMs(row.created_at_epoch),
  };
}

/** The session summary as the server's generator renders it. */
export function summaryItem(row: Record<string, unknown>, databaseId: string): ImportItem | null {
  return withoutInlineBinary(summaryItemRaw(row, databaseId));
}

function summaryItemRaw(row: Record<string, unknown>, databaseId: string): ImportItem | null {
  const fields = ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'] as const;
  const labels: Record<typeof fields[number], string> = {
    request: 'Request', investigated: 'Investigated', learned: 'Learned', completed: 'Completed', next_steps: 'Next steps', notes: 'Notes',
  };
  const content = fields.map(field => text(row[field]) ? `${labels[field]}: ${row[field]}` : null).filter(Boolean).join('\n\n').trim();
  if (!content) return null;
  return {
    key: `${databaseId}:session_summaries:${row.id}`,
    kind: 'summary',
    content,
    metadata: {
      ...Object.fromEntries(fields.map(field => [field, text(row[field])])),
      files_read: list(row.files_read),
      files_edited: list(row.files_edited),
      project: row.target_project,
      platformSource: text(row.platform_source) ?? 'claude',
      importedFrom: { table: 'session_summaries', id: row.id },
    },
    createdAtEpoch: epochMs(row.created_at_epoch),
  };
}

/** A copy of the database and its WAL, so the import never touches the original. */
function openCopy(dbPath: string): { db: Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-import-'));
  const copy = join(dir, 'claude-mem.db');
  copyFileSync(dbPath, copy);
  if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, `${copy}-wal`);
  const db = new Database(copy);
  return { db, cleanup: () => { try { db.close(); } catch { /* closing */ } rmSync(dir, { recursive: true, force: true }); } };
}

/** A stable id for this database: its first observation, which never changes. */
function databaseIdOf(db: Database): string {
  const first = db.query('SELECT memory_session_id, created_at_epoch FROM observations ORDER BY id LIMIT 1').get() as Record<string, unknown> | null;
  const seed = first ? `${first.memory_session_id}:${first.created_at_epoch}` : 'empty';
  return createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

const PROJECT_SQL = `COALESCE(NULLIF(o.merged_into_project, ''), o.project)`;

export async function runServerHistoryImport(options: ImportOptions, log: (line: string) => void = line => { process.stdout.write(`${line}\n`); }): Promise<number> {
  if (!existsSync(options.dbPath)) {
    log(`No local database at ${options.dbPath}; nothing to import.`);
    return 0;
  }
  if (!options.dryRun && selectRuntime() !== 'server') {
    log('This machine is not on the server runtime yet. Switch it first (instructions, part 1), then run the import.');
    return 1;
  }
  const runtime = options.dryRun ? null : buildServerContext(process.cwd());
  if (!options.dryRun && !runtime) {
    log('CLAUDE_MEM_SERVER_URL or CLAUDE_MEM_SERVER_API_KEY is missing in ~/.claude-mem/settings.json.');
    return 1;
  }

  log(`Reading ${options.dbPath} (${(statSync(options.dbPath).size / 1e6).toFixed(0)} MB, copied first; the original is not touched)`);
  const { db, cleanup } = openCopy(options.dbPath);
  try {
    const databaseId = databaseIdOf(db);
    const projectFilter = options.project ? `WHERE ${PROJECT_SQL} = ?` : '';
    const projectArgs = options.project ? [options.project] : [];
    const projects = db.query(`SELECT ${PROJECT_SQL} AS name, count(*) AS n FROM observations o ${projectFilter} GROUP BY 1 ORDER BY 2 DESC`)
      .all(...projectArgs) as Array<{ name: string; n: number }>;
    const summaryProjects = new Map((db.query(`SELECT ${PROJECT_SQL} AS name, count(*) AS n FROM session_summaries o ${projectFilter} GROUP BY 1`)
      .all(...projectArgs) as Array<{ name: string; n: number }>).map(row => [row.name, row.n]));
    const names = [...new Set([...projects.map(p => p.name), ...summaryProjects.keys()])].filter(Boolean);
    const totals = { inserted: 0, existing: 0, skipped: 0, failed: 0 };

    for (const name of names) {
      const observationCount = projects.find(p => p.name === name)?.n ?? 0;
      const summaryCount = summaryProjects.get(name) ?? 0;
      log(`\n${name}: ${observationCount} observations, ${summaryCount} summaries`);
      if (options.dryRun) continue;
      const result = { inserted: 0, existing: 0, skipped: 0, failed: 0 };
      const send = async (items: ImportItem[]) => {
        for (let attempt = 1; ; attempt++) {
          try {
            const response = await runtime!.client.importObservations({ projectId: `name:${name}`, items });
            result.inserted += response.inserted ?? 0;
            result.existing += response.existing ?? 0;
            return;
          } catch (error) {
            if (attempt >= RETRIES) {
              result.failed += items.length;
              log(`  ! ${items.length} rows not sent: ${error instanceof Error ? error.message : String(error)}`);
              return;
            }
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
          }
        }
      };
      for (const [table, toItem] of [['observations', observationItem], ['session_summaries', summaryItem]] as const) {
        const statement = db.query(`
          SELECT o.*, ${PROJECT_SQL} AS target_project, s.platform_source
          FROM ${table} o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
          WHERE ${PROJECT_SQL} = ? AND o.id > ? ORDER BY o.id LIMIT ?`);
        let after = 0;
        for (;;) {
          const rows = statement.all(name, after, options.batchSize) as Array<Record<string, unknown>>;
          if (rows.length === 0) break;
          after = Number(rows[rows.length - 1]!.id);
          const items = rows.map(row => toItem(row, databaseId)).filter((item): item is ImportItem => item !== null);
          result.skipped += rows.length - items.length;
          if (items.length) await send(items);
          log(`  ${table}: up to #${after} — ${result.inserted} new, ${result.existing} already there`);
        }
      }
      log(`  done: ${result.inserted} new, ${result.existing} already there, ${result.skipped} empty, ${result.failed} failed`);
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += result[key];
    }

    if (options.dryRun) {
      log('\nDry run: nothing was sent. Run again without --dry-run to import.');
      return 0;
    }
    log(`\nImported: ${totals.inserted} new, ${totals.existing} already there, ${totals.skipped} empty, ${totals.failed} failed.`);
    log('The server computes vectors for search by meaning in the background; keyword search finds them now.');
    if (totals.failed > 0) log('Some rows failed; running the same command again sends only what is missing.');
    return totals.failed > 0 ? 1 : 0;
  } finally {
    cleanup();
  }
}
