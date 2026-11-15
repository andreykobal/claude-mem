import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildServerContext, SERVER_PROJECT_NAME_REF_PREFIX } from '../../hooks/runtime-selector.js';
import { getProjectContext } from '../../../utils/project-name.js';
import { paths } from '../../../shared/paths.js';
import { resolveDateBound } from '../../../shared/date-bounds.js';
import { assembleCorpusFile } from './CorpusBuilder.js';
import { CorpusStore } from './CorpusStore.js';
import { createCorpusAgent } from './CorpusAgent.js';
import type { CorpusFile, CorpusFilter, CorpusObservation } from './types.js';

/**
 * Knowledge corpora in server runtime (the corpus MCP tools; `worker-service
 * corpus-server`). The observations come from the server
 * (/v1/observations/select); the corpus file and the agent session stay on
 * this machine, under corpora/server/<project>, apart from local-worker
 * corpora. prime and query run the corpus agent the settings choose, on the
 * user's own account, only when the user asks: no local worker is started.
 */

export type ServerCorpusOp = 'build' | 'list' | 'prime' | 'query' | 'rebuild' | 'reprime';

export interface ServerCorpusRequest {
  op: ServerCorpusOp;
  cwd: string;
  args: Record<string, unknown>;
}

export interface ServerCorpusOutcome {
  status: number;
  body: Record<string, unknown>;
}

const CORPUS_NAME = /^[A-Za-z0-9._-]{1,100}$/;

function stringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return items.map(item => String(item).trim()).filter(Boolean);
}

function metadataOf(corpus: CorpusFile): Record<string, unknown> {
  const { observations: _observations, ...metadata } = corpus;
  return metadata;
}

/** A rebuild that keeps half or less of a non-trivial corpus must be confirmed (CorpusRoutes). */
function isDestructiveShrink(previousCount: number, newCount: number): boolean {
  return previousCount >= 4 && newCount <= previousCount / 2;
}

function toCorpusObservation(row: { id: string; content?: string; kind?: unknown; metadata?: unknown; createdAtEpoch?: unknown }, project: string): CorpusObservation {
  const meta = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<string, unknown>;
  const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const createdAtEpoch = typeof row.createdAtEpoch === 'number' ? row.createdAtEpoch : 0;
  return {
    id: row.id,
    type: typeof row.kind === 'string' ? row.kind : 'discovery',
    title: typeof meta.title === 'string' ? meta.title : String(row.content ?? '').split('\n')[0] ?? '',
    subtitle: typeof meta.subtitle === 'string' ? meta.subtitle : null,
    narrative: typeof meta.narrative === 'string' ? meta.narrative : (row.content ?? null),
    facts: list(meta.facts),
    concepts: list(meta.concepts),
    files_read: list(meta.files_read),
    files_modified: list(meta.files_modified),
    project: typeof meta.project === 'string' && meta.project ? meta.project : project,
    created_at: new Date(createdAtEpoch).toISOString(),
    created_at_epoch: createdAtEpoch,
  };
}

/** One operation per corpus at a time, across processes: an exclusive lock file. */
function withCorpusLock<T>(dir: string, name: string, work: () => Promise<T>): Promise<T | ServerCorpusOutcome> {
  const lockPath = join(dir, `${name}.lock`);
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch {
    return Promise.resolve({ status: 409, body: { error: `Corpus "${name}" already has an operation in progress`, code: 'CORPUS_BUSY' } });
  }
  closeSync(fd);
  return work().finally(() => rmSync(lockPath, { force: true }));
}

export async function runServerCorpusCommand(request: ServerCorpusRequest): Promise<ServerCorpusOutcome> {
  const runtime = buildServerContext(request.cwd);
  if (!runtime) {
    return { status: 400, body: { error: 'Server runtime is selected but CLAUDE_MEM_SERVER_URL or CLAUDE_MEM_SERVER_API_KEY is missing.' } };
  }
  const args = request.args ?? {};
  const project = typeof args.project === 'string' && args.project.trim()
    ? args.project.trim()
    : getProjectContext(request.cwd).primary;
  const projectId = runtime.projectId.startsWith(SERVER_PROJECT_NAME_REF_PREFIX)
    ? `${SERVER_PROJECT_NAME_REF_PREFIX}${project}`
    : runtime.projectId;
  const dir = join(paths.corpora(), 'server', projectId.replace(/[^A-Za-z0-9._-]/g, '_'));
  mkdirSync(dir, { recursive: true });
  const store = new CorpusStore(dir);

  if (request.op === 'list') {
    return { status: 200, body: { corpora: store.list() } };
  }

  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!CORPUS_NAME.test(name)) {
    return { status: 400, body: { error: 'name must be 1-100 letters, digits, dots, dashes or underscores.' } };
  }

  const select = async (filter: CorpusFilter): Promise<CorpusObservation[]> => {
    const { observations } = await runtime.client.selectObservations({
      projectId,
      ...(filter.query ? { query: filter.query } : {}),
      ...(filter.types?.length ? { types: filter.types } : {}),
      ...(filter.concepts?.length ? { concepts: filter.concepts } : {}),
      ...(filter.files?.length ? { files: filter.files } : {}),
      ...(filter.date_start ? { dateStart: filter.date_start } : {}),
      ...(filter.date_end ? { dateEnd: filter.date_end } : {}),
      limit: Math.min(500, filter.limit ?? 500),
    }, { timeoutMs: 60_000 });
    return (observations ?? []).map(row => toCorpusObservation(row, project));
  };

  return withCorpusLock(dir, name, async (): Promise<ServerCorpusOutcome> => {
    if (request.op === 'build') {
      const dateStart = (args.date_start ?? args.dateStart) as string | undefined;
      const dateEnd = (args.date_end ?? args.dateEnd) as string | undefined;
      try {
        if (dateStart) resolveDateBound(dateStart, 'start');
        if (dateEnd) resolveDateBound(dateEnd, 'end');
      } catch (error) {
        return { status: 400, body: { error: error instanceof Error ? error.message : 'invalid date bound' } };
      }
      const filter: CorpusFilter = {};
      filter.project = project;
      const types = stringList(args.types);
      const concepts = stringList(args.concepts);
      const files = stringList(args.files);
      if (types.length) filter.types = types;
      if (concepts.length) filter.concepts = concepts;
      if (files.length) filter.files = files;
      if (typeof args.query === 'string' && args.query.trim()) filter.query = args.query.trim();
      if (dateStart) filter.date_start = dateStart;
      if (dateEnd) filter.date_end = dateEnd;
      if (typeof args.limit === 'number' && args.limit > 0) filter.limit = Math.min(500, Math.floor(args.limit));
      const description = typeof args.description === 'string' ? args.description : '';
      const corpus = assembleCorpusFile(name, description, filter, await select(filter));
      store.write(corpus);
      return { status: 200, body: metadataOf(corpus) };
    }

    const corpus = store.read(name);
    if (!corpus) {
      return { status: 404, body: { error: `Corpus "${name}" not found`, available: store.list().map(entry => entry.name) } };
    }

    if (request.op === 'rebuild') {
      const rebuilt = assembleCorpusFile(name, corpus.description, corpus.filter, await select(corpus.filter));
      const previousCount = corpus.stats.observation_count;
      const newCount = rebuilt.stats.observation_count;
      if (args.force !== true && isDestructiveShrink(previousCount, newCount)) {
        return {
          status: 409,
          body: {
            error: `Rebuild would shrink corpus "${name}" from ${previousCount} to ${newCount} observations`,
            fix: 'The previous corpus was kept. Re-run with force=true to accept the smaller result, or check the stored date filter.',
            previous_count: previousCount,
            rebuilt_count: newCount,
          },
        };
      }
      store.write(rebuilt);
      return { status: 200, body: metadataOf(rebuilt) };
    }

    const agent = await createCorpusAgent(store);
    if (request.op === 'prime' || request.op === 'reprime') {
      const sessionId = request.op === 'prime' ? await agent.prime(corpus) : await agent.reprime(corpus);
      return { status: 200, body: { session_id: sessionId, name: corpus.name } };
    }
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    if (!question) return { status: 400, body: { error: 'question is required' } };
    const result = await agent.query(corpus, question);
    return { status: 200, body: { ...result } as Record<string, unknown> };
  }).then(outcome => outcome as ServerCorpusOutcome);
}
