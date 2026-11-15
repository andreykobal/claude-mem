/**
 * The MCP server your agent searches memory through.
 *
 * Its core is the three-step mem-search workflow: `search` for a compact
 * index, `timeline` for what happened around a result, `get_observations`
 * for full details of only the IDs that matter. It also offers code
 * navigation (smart_*), saving a note on purpose (save_memory) and work
 * state. The memory tools answer by calling the worker over HTTP
 * (callWorker); the smart_* code tools read files in the workspace directly.
 */

declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

import { logger } from '../utils/logger.js';
import { spoolWorkStateMcpInstruction, spoolWorkStateMcpResult } from '../cli/work-state-telemetry.js';
import { mcpServerInstructions } from '../shared/memory-instructions.js';

console['log'] = (...args: any[]) => {
  logger.error('CONSOLE', 'Intercepted console output (MCP protocol protection)', undefined, { args });
};

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getWorkerPort, workerHttpRequest, resolveWorkerScriptPath } from '../shared/worker-utils.js';
import { ensureWorkerStarted } from '../services/worker-spawner.js';
import { searchCodebase, formatSearchResults } from '../services/smart-file-read/search.js';
import { parseFile, formatFoldedView, unfoldSymbol, formatAvailableSymbols } from '../services/smart-file-read/parser.js';
import { treeSitterCliUnavailableMessage } from '../services/smart-file-read/tree-sitter-bin-path.js';
import { resolveWithinWorkspace } from '../services/smart-file-read/workspace-path.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { marketplaceDirectoryCandidates } from '../shared/known-marketplace-location.js';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  ServerClientError,
  isServerClientError,
  type ServerAddObservationRequest,
  type ServerContextObservationsRequest,
  type ServerRecordEventRequest,
  type ServerSearchObservationsRequest,
} from '../services/hooks/server-client.js';
import {
  selectRuntime,
  buildServerContext,
  type SelectedRuntime,
  type ServerRuntimeContext,
} from '../services/hooks/runtime-selector.js';
import { normalizePlatformSource } from '../shared/platform-source.js';
import {
  getAdvertisedMcpToolsForRuntime,
  TEAMBRAIN_TOOL_NAMES,
  withoutDisabledWorkStateTools,
  withoutUnjoinedTeamBrainTools,
  WORK_STATE_TOOL_NAMES,
} from './mcp-tool-visibility.js';
import { loadFromFileOnce, readLocalApiToken } from '../shared/hook-settings.js';
import { teamBrainConnection } from '../shared/teambrain.js';
import { isWorkStateEnabled } from '../shared/work-state-setting.js';
import { getProjectContext, type ProjectContext } from '../utils/project-name.js';
import { withCheckoutProjects } from './checkout-search-scope.js';
import { parseProjectList, projectsQueryValues } from '../shared/project-list.js';
import { postCorpusRequestOverSse } from './corpus-worker-stream.js';
import { withWorkerRestartOnRefusedConnection } from './worker-restart.js';
import { ProgressiveSearch, ProgressiveSearchError, progressiveSearchToolError, progressiveSearchToolResult, projectMemoryContent, type MemoryIndexRow, type ProgressiveBackend } from '../shared/progressive-search.js';
import { formatMcpPayload, formatWorkerMcpResponse, formatWorkStateMcpResponse, mcpTextResult, workerFailureText, serverFailureText, type McpTextPurpose } from './mcp-text-format.js';
import { getRequestCwd, runWithCwd } from './request-context.js';
import { isProjectExcluded } from '../utils/project-filter.js';
import { workStateReadReply, workStateWriteRefusal, workStateWriteReply } from '../shared/work-state-write.js';
import { readServerWorkStateSection, toWorkStateEntries } from '../services/context/ServerWorkState.js';
import { SERVER_PROJECT_NAME_REF_PREFIX } from '../services/hooks/runtime-selector.js';
import { parseHttpArgs, startMcpHttpServer, type CwdResolver, type McpHttpOptions } from './mcp-http.js';
import { createStdioCwdResolver } from './mcp-project-cwd.js';
import { resolveWorkerRuntimePath } from '../services/infrastructure/ProcessManager.js';
import { sanitizeEnv } from '../supervisor/env-sanitizer.js';
import { buildWorkerOriginPolicy } from '../services/worker/http/origin-policy.js';

/**
 * The checkout of the running tool call, resolved once per directory. Over stdio that is
 * the workspace Claude Code started this process in; over HTTP it is the session's cwd.
 */
const checkoutByCwd = new Map<string, ProjectContext>();
function currentCheckout(): ProjectContext {
  const cwd = getRequestCwd();
  let checkout = checkoutByCwd.get(cwd);
  if (!checkout) {
    checkout = getProjectContext(cwd);
    checkoutByCwd.set(cwd, checkout);
  }
  return checkout;
}

let mcpServerDirResolutionFailed = false;
const mcpServerDir = (() => {
  if (typeof __dirname !== 'undefined') return __dirname;
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch (error) {
    mcpServerDirResolutionFailed = true;
    logger.warn('SYSTEM', 'mcp-server: failed to resolve module directory from import.meta.url, falling back to process.cwd()', undefined, error instanceof Error ? error : new Error(String(error)));
    return process.cwd();
  }
})();
// Prefer the canonical marketplace copy of the worker bundle (same
// marketplace-first candidates as the hook launcher) over this server's own
// directory: an MCP server still running out of a stale plugin cache dir
// would otherwise auto-spawn a stale worker. The own-dir resolution stays as
// the fallback for installs without a marketplace copy.
const WORKER_SCRIPT_PATH = resolveWorkerScriptPath() ?? resolve(mcpServerDir, 'worker-service.cjs');
const MCP_PLUGIN_ROOT = resolve(mcpServerDir, '..');

function errorIfWorkerScriptMissing(): void {
  if (!mcpServerDirResolutionFailed) return;
  if (existsSync(WORKER_SCRIPT_PATH)) return;

  logger.error(
    'SYSTEM',
    'mcp-server: dirname resolution failed (both __dirname and import.meta.url are unavailable). Fell back to process.cwd() and the resolved WORKER_SCRIPT_PATH does not exist. This is the actual problem — the worker bundle is fine, but mcp-server cannot locate it. Worker auto-start will fail until the dirname-resolution path is fixed.',
    { workerScriptPath: WORKER_SCRIPT_PATH, mcpServerDir }
  );
}

interface WorkerCallOptions {
  query?: Record<string, any>;
  body?: Record<string, any>;
  text?: boolean;
  /** Long corpus work: read the worker's SSE heartbeat stream instead of one JSON reply. */
  streamCorpusProgress?: boolean;
}

type WorkerToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function workerResultPurpose(endpoint: string, writes: boolean): McpTextPurpose {
  if (endpoint === '/api/memory/save') return 'save';
  if (endpoint === '/api/observations/batch') return 'observations';
  if (endpoint === '/api/tool-uses/batch') return 'tool-uses';
  if (endpoint === '/api/corpus') return writes ? 'corpus-build' : 'corpus-list';
  if (/\/corpus\/[^/]+\/(?:prime|reprime)$/.test(endpoint)) return 'corpus-prime';
  if (/\/corpus\/[^/]+\/rebuild$/.test(endpoint)) return 'corpus-build';
  if (/\/corpus\/[^/]+\/query$/.test(endpoint)) return 'corpus-query';
  return endpoint === '/api/search' ? 'search' : 'context';
}

async function callWorker(endpoint: string, opts: WorkerCallOptions = {}): Promise<WorkerToolResult> {
  // Server runtime has no local worker: a tool without a server branch says so
  // instead of reaching a worker that may be stale (its store is not the
  // server's) or absent. See shared/server-runtime-support.ts.
  if (selectRuntime() === 'server') {
    return mcpTextResult(`This tool is not available in server runtime yet (it needs the local worker, ${endpoint.split('?')[0]}); no local request was made.`, true);
  }
  logger.debug('SYSTEM', '→ Worker API', undefined, { endpoint });

  try {
    // The worker can exit while this server runs (idle exit, a crash,
    // `claude-mem stop`); a refused connection starts it once and resends.
    return await withWorkerRestartOnRefusedConnection(
      () => requestWorker(endpoint, opts),
      startWorkerAfterRefusedConnection,
    );
  } catch (error: unknown) {
    logger.error('SYSTEM', '← Worker API error', { endpoint }, error instanceof Error ? error : new Error(String(error)));
    return mcpTextResult(workerFailureText(error instanceof Error ? error.message : ''), true);
  }
}

async function requestWorker(endpoint: string, opts: WorkerCallOptions): Promise<WorkerToolResult> {
  if (opts.streamCorpusProgress && opts.body) {
    const corpusResult = await postCorpusRequestOverSse(endpoint, opts.body);
    logger.debug('SYSTEM', '← Worker API success', undefined, { endpoint });
    return formatWorkerMcpResponse(workerResultPurpose(endpoint, true), corpusResult);
  }

  let response: Response;
  if (opts.body) {
    response = await workerHttpRequest(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body)
    });
  } else {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== null) {
        for (const entry of Array.isArray(value) ? value : [value]) {
          searchParams.append(key, String(entry));
        }
      }
    }
    response = await workerHttpRequest(`${endpoint}?${searchParams}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker API error (${response.status}): ${errorText}`);
  }

  logger.debug('SYSTEM', '← Worker API success', undefined, { endpoint });

  if (opts.text) {
    const text = await response.text();
    return endpoint === '/api/work-state' ? formatWorkStateMcpResponse(text) : mcpTextResult(text);
  }
  return formatWorkerMcpResponse(workerResultPurpose(endpoint, Boolean(opts.body)), await response.json());
}

/**
 * Start the worker after it refused a tool call. Same rule as startup: with
 * CLAUDE_MEM_RUNTIME=server the MCP server never starts it, and
 * ensureWorkerStarted itself honors CLAUDE_MEM_WORKER_AUTOSTART=false.
 */
async function startWorkerAfterRefusedConnection(): Promise<boolean> {
  if (selectRuntime() === 'server') return false;
  return ensureWorkerConnection();
}

async function verifyWorkerConnection(): Promise<boolean> {
  try {
    const response = await workerHttpRequest('/api/health');
    return response.ok;
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Worker health check failed', {}, error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

// Phase 8 — runtime selection for MCP tools.
// In server mode, observation_* tools talk to the server `/v1`
// endpoints via the SAME ServerClient hooks use. This guarantees we
// share the REST core for writes and searches; we never duplicate the
// event-insert + outbox + enqueue logic on the MCP side.
//
// We deliberately resolve the runtime per-call (cheap; reads cached
// settings) so the user can flip CLAUDE_MEM_RUNTIME without restarting
// the MCP server.
type ServerToolContext = ServerRuntimeContext;

interface ServerUnavailable {
  // Phase 1a (cmem-sdk rename): canonical runtime literal is `'server'`.
  runtime: 'server';
  available: false;
  reason: string;
}

interface ServerAvailable extends ServerToolContext {
  available: true;
}

type ServerResolution = ServerAvailable | ServerUnavailable;

function resolveServerToolContext(): ServerResolution | null {
  const runtime: SelectedRuntime = selectRuntime();
  // Phase 1a (cmem-sdk rename): canonical runtime literal is `'server'`.
  // `selectRuntime()` accepts legacy `'server-beta'` settings and returns
  // `'server'` for either.
  if (runtime !== 'server') {
    return null;
  }
  const ctx = buildServerContext();
  if (!ctx) {
    return {
      runtime: 'server',
      available: false,
      reason: 'server runtime is selected but configuration is incomplete (missing url, api key, or project id)',
    };
  }
  return { ...ctx, available: true };
}

function formatToolError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  if (isServerClientError(error)) {
    const text = error.kind === 'transport' && error.message.includes(' requires CLAUDE_MEM_RUNTIME=server.')
      ? error.message : serverFailureText(error.kind, error.status);
    return { content: mcpTextResult(text).content, isError: true };
  }
  return {
    content: [{
      type: 'text' as const,
      text: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
    }],
    isError: true as const,
  };
}

function requireServerForObservationTool(toolName: string): ServerAvailable {
  const resolution = resolveServerToolContext();
  if (!resolution) {
    throw new ServerClientError(
      'transport',
      `${toolName} requires CLAUDE_MEM_RUNTIME=server. Current runtime is "worker"; use the existing search/timeline/get_observations tools for worker-mode memory access.`,
    );
  }
  if (!resolution.available) {
    throw new ServerClientError('missing_api_key', `${toolName}: ${resolution.reason}`);
  }
  return resolution;
}

function wrapHandler<Args>(
  toolName: string,
  execute: (args: Args) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
): (args: Args) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return async (args: Args) => {
    try {
      return await execute(args);
    } catch (error) {
      if (isServerClientError(error)) logger.warn('SYSTEM', `${toolName} failed`, { errorKind: error.kind, status: error.status });
      else logger.warn('SYSTEM', `${toolName} failed`, undefined, error instanceof Error ? error : new Error(String(error)));
      return formatToolError(error);
    }
  };
}

interface ObservationAddArgs {
  projectId?: string;
  serverSessionId?: string | null;
  contentSessionId?: string | null;
  platformSource?: string | null;
  kind?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

const handleObservationAdd = wrapHandler('observation_add', async (args: ObservationAddArgs) => {
  const ctx = requireServerForObservationTool('observation_add');
  if (typeof args?.content !== 'string' || args.content.trim().length === 0) {
    throw new Error('observation_add: "content" is required');
  }
  const projectId = args.projectId && args.projectId.trim().length > 0 ? args.projectId : ctx.projectId;
  const request: ServerAddObservationRequest = {
    projectId,
    content: args.content,
    ...(args.serverSessionId !== undefined ? { serverSessionId: args.serverSessionId } : {}),
    ...(args.contentSessionId !== undefined ? { contentSessionId: args.contentSessionId } : {}),
    ...(args.platformSource !== undefined ? { platformSource: args.platformSource } : {}),
    ...(args.kind !== undefined ? { kind: args.kind } : {}),
    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
  };
  const response = await ctx.client.addObservation(request);
  return formatMcpPayload('observation-add', response);
});

interface ObservationRecordEventArgs {
  projectId?: string;
  serverSessionId?: string | null;
  contentSessionId?: string | null;
  memorySessionId?: string | null;
  platformSource?: string | null;
  sourceType?: 'hook' | 'worker' | 'provider' | 'server' | 'api';
  eventType: string;
  payload?: unknown;
  occurredAtEpoch?: number;
  generate?: boolean;
}

function normalizeMcpPlatformSource(value: string | null): string | null {
  return typeof value === 'string' ? normalizePlatformSource(value) : null;
}

const handleObservationRecordEvent = wrapHandler('observation_record_event', async (args: ObservationRecordEventArgs) => {
  const ctx = requireServerForObservationTool('observation_record_event');
  if (typeof args?.eventType !== 'string' || args.eventType.trim().length === 0) {
    throw new Error('observation_record_event: "eventType" is required');
  }
  const projectId = args.projectId && args.projectId.trim().length > 0 ? args.projectId : ctx.projectId;
  const request: ServerRecordEventRequest = {
    projectId,
    sourceType: args.sourceType ?? 'api',
    eventType: args.eventType,
    occurredAtEpoch: typeof args.occurredAtEpoch === 'number' ? args.occurredAtEpoch : Date.now(),
    ...(args.serverSessionId !== undefined ? { serverSessionId: args.serverSessionId } : {}),
    ...(args.contentSessionId !== undefined ? { contentSessionId: args.contentSessionId } : {}),
    ...(args.memorySessionId !== undefined ? { memorySessionId: args.memorySessionId } : {}),
    ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource) } : {}),
    ...(args.payload !== undefined ? { payload: args.payload } : {}),
    ...(args.generate !== undefined ? { generate: args.generate } : {}),
  };
  const response = await ctx.client.recordEvent(request);
  return formatMcpPayload('event', response);
});

interface ObservationSearchArgs {
  projectId?: string;
  query: string;
  limit?: number;
  platformSource?: string | null;
}

const handleObservationSearch = wrapHandler('observation_search', async (args: ObservationSearchArgs) => {
  const ctx = requireServerForObservationTool('observation_search');
  if (typeof args?.query !== 'string' || args.query.trim().length === 0) {
    throw new Error('observation_search: "query" is required');
  }
  const projectId = args.projectId && args.projectId.trim().length > 0 ? args.projectId : ctx.projectId;
  const request: ServerSearchObservationsRequest = {
    projectId,
    query: args.query,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource) } : {}),
  };
  const response = await ctx.client.searchObservations(request);
  return formatMcpPayload('server-search', response);
});

interface ObservationContextArgs {
  projectId?: string;
  // Optional: omit for "recent" (recency-ordered) context instead of a
  // relevance-ranked search (plan-24 step 4, #2991).
  query?: string;
  limit?: number;
  platformSource?: string | null;
}

const handleObservationContext = wrapHandler('observation_context', async (args: ObservationContextArgs) => {
  const ctx = requireServerForObservationTool('observation_context');
  const hasQuery = typeof args?.query === 'string' && args.query.trim().length > 0;
  const projectId = args.projectId && args.projectId.trim().length > 0 ? args.projectId : ctx.projectId;
  const request: ServerContextObservationsRequest = {
    projectId,
    ...(hasQuery ? { query: args.query } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource) } : {}),
  };
  const response = await ctx.client.contextObservations(request);
  return formatMcpPayload('context', response);
});

interface ObservationGenerationStatusArgs {
  jobId?: string;
  job_id?: string;
}

interface SessionStartContextArgs {
  project?: string;
  projects?: string[] | string;
  platformSource?: string | null;
  full?: boolean;
  colors?: boolean;
}

function normalizeProjectsArg(args: SessionStartContextArgs): string[] {
  if (args.projects !== undefined) {
    return parseProjectList(args.projects);
  }
  if (typeof args.project === 'string' && args.project.trim().length > 0) {
    return [args.project];
  }
  return [];
}

async function handleSessionStartContext(
  args: SessionStartContextArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const projects = normalizeProjectsArg(args);
  if (projects.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: 'session_start_context: "project" or "projects" is required',
      }],
      isError: true,
    };
  }

  if (selectRuntime() === 'server') return serverSessionStartContext(args, projects);

  return callWorker('/api/context/inject', {
    query: {
      projects: projectsQueryValues(projects),
      ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource) } : {}),
      ...(args.full !== undefined ? { full: args.full } : {}),
      ...(args.colors !== undefined ? { colors: args.colors } : {}),
    },
    text: true,
  });
}

/**
 * session_start_context in server runtime: the open work-state lists and the
 * project's most recent observations, both read from the server. This process
 * runs under Node and cannot load the SQLite-backed SessionStart renderer, so
 * the rows come as observation_context shows them; the SessionStart hook
 * itself renders the full block. No local worker is asked.
 */
async function serverSessionStartContext(
  args: SessionStartContextArgs,
  projects: string[],
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const project = projects[projects.length - 1];
  const runtime = serverContextForProject(project);
  if (!runtime) return mcpTextResult(serverConfigIncompleteText('session_start_context'), true);
  try {
    const platformSource = args.platformSource ? normalizeMcpPlatformSource(args.platformSource) : undefined;
    const [workStateSection, recent] = await Promise.all([
      workStateEnabled() ? readServerWorkStateSection(runtime, project) : Promise.resolve(''),
      runtime.client.contextObservations({
        projectId: runtime.projectId,
        ...(platformSource !== undefined ? { platformSource } : {}),
      }),
    ]);
    const observations = (recent?.observations?.length ?? 0) > 0
      ? formatMcpPayload('context', recent).content[0].text
      : `No observations stored for ${project} yet.`;
    return mcpTextResult([workStateSection, observations].filter(Boolean).join('\n\n'));
  } catch (error) {
    return formatToolError(error);
  }
}

/**
 * The server context for a project name: the configured server project when
 * CLAUDE_MEM_SERVER_PROJECT_ID is set, otherwise `name:<project>`, the
 * reference the hooks send for the same checkout.
 */
function serverContextForProject(project: string): ServerRuntimeContext | null {
  const ctx = buildServerContext(getRequestCwd());
  if (!ctx) return null;
  return ctx.projectId.startsWith(SERVER_PROJECT_NAME_REF_PREFIX)
    ? { ...ctx, projectId: `${SERVER_PROJECT_NAME_REF_PREFIX}${project}` }
    : ctx;
}

/**
 * The checkout's project keys as server project references when the read is
 * for this checkout and it has several (a worktree and its parent), so ids a
 * search returns from the parent open in timeline and get_observations too.
 */
function checkoutProjectIds(runtime: ServerRuntimeContext, explicitProject: unknown): string[] | undefined {
  if (typeof explicitProject === 'string' && explicitProject.trim()) return undefined;
  if (!runtime.projectId.startsWith(SERVER_PROJECT_NAME_REF_PREFIX)) return undefined;
  const keys = currentCheckout().allProjects;
  return keys.length > 1 ? keys.slice(-20).map(key => `${SERVER_PROJECT_NAME_REF_PREFIX}${key}`) : undefined;
}

function serverConfigIncompleteText(toolName: string): string {
  return `${toolName}: server runtime is selected but CLAUDE_MEM_SERVER_URL or CLAUDE_MEM_SERVER_API_KEY is missing in ~/.claude-mem/settings.json.`;
}

/** A server refusal (bad fields, a viewer-only list) reads as the server's own words; anything else as a server failure. */
function workStateServerError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  if (isServerClientError(error) && (error.status === 400 || error.status === 403)) {
    return { content: mcpTextResult(error.message).content, isError: true };
  }
  return formatToolError(error);
}

/**
 * save_memory in server runtime: the note goes to the server project of
 * `project` (default: this checkout), shaped like the worker's manual memory
 * (save-memory.ts) so search, SessionStart and get_observations read it alike.
 * A sourceFingerprint makes a repeat save return the first note, as the worker
 * deduplicates on it.
 */
async function serverSaveMemory(args: { text?: unknown; title?: unknown; project?: unknown; metadata?: unknown }) {
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) return mcpTextResult('Not saved: "text" is required.', true);
  const cwd = getRequestCwd();
  if (isProjectExcluded(cwd, loadFromFileOnce().CLAUDE_MEM_EXCLUDED_PROJECTS)) {
    return mcpTextResult('Not saved: this project is excluded from claude-mem (CLAUDE_MEM_EXCLUDED_PROJECTS).');
  }
  const project = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : currentCheckout().primary;
  const runtime = serverContextForProject(project);
  if (!runtime) return mcpTextResult(serverConfigIncompleteText('save_memory'), true);
  const title = typeof args.title === 'string' && args.title.trim()
    ? args.title.trim()
    : text.length > 60 ? `${text.slice(0, 60)}...` : text;
  const extra = args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
    ? args.metadata as Record<string, unknown>
    : {};
  const fingerprint = typeof extra.sourceFingerprint === 'string' && extra.sourceFingerprint ? extra.sourceFingerprint : null;
  const platformSource = typeof extra.platformSource === 'string' ? extra.platformSource : null;
  try {
    const response = await runtime.client.addObservation({
      projectId: runtime.projectId,
      kind: 'discovery',
      content: `${title}\nManual memory\n${text}`,
      metadata: {
        ...extra,
        title,
        subtitle: 'Manual memory',
        narrative: text,
        facts: [],
        concepts: [],
        files_read: [],
        files_modified: [],
        project,
      },
      ...(fingerprint
        ? { generationKey: `memory:${createHash('sha256').update(`${project}\0${platformSource ?? ''}\0${fingerprint}`).digest('hex')}` }
        : {}),
    });
    const memory = (response as { memory?: { id?: string }; existing?: boolean }).memory;
    const existing = (response as { existing?: boolean }).existing === true;
    return mcpTextResult(existing
      ? `Already saved as #${memory?.id} in ${project}.`
      : `Saved memory #${memory?.id} "${title}" in ${project}.`);
  } catch (error) {
    return formatToolError(error);
  }
}

const SEARCH_CATEGORIES = new Set(['all', 'observations', 'sessions', 'prompts']);
const SEARCH_ORDER_VALUES = new Set(['relevance', 'date_desc', 'date_asc']);

function csvList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return items.map(item => String(item).trim()).filter(Boolean);
}

/**
 * The worker's search arguments as a server search: `type` is a category
 * (observations, sessions, prompts, all) or else an observation type, as the
 * worker reads it (resolveTypeFilters); `obs_type` and `concepts` take comma
 * lists; `project` picks the server project, as the hooks name it.
 */
function serverSearchRequest(args: Record<string, unknown>):
  | { project: string; search: Omit<import('../services/hooks/server-client.js').ServerSearchObservationsRequest, 'projectId'> }
  | { error: string } {
  const query = typeof args.query === 'string' && args.query.trim() ? args.query : undefined;
  const type = typeof args.type === 'string' ? args.type.trim() : '';
  const category = SEARCH_CATEGORIES.has(type) ? type as 'all' | 'observations' | 'sessions' | 'prompts' : undefined;
  const observationTypes = [...csvList(args.obs_type), ...(type && !category ? csvList(type) : [])];
  const observationConcepts = csvList(args.concepts ?? args.concept);
  const orderBy = typeof args.orderBy === 'string' ? args.orderBy : undefined;
  if (orderBy !== undefined && !SEARCH_ORDER_VALUES.has(orderBy)) {
    return { error: 'orderBy must be relevance, date_desc or date_asc.' };
  }
  const dateStart = args.dateStart ?? args.date_start ?? args.date_from;
  const dateEnd = args.dateEnd ?? args.date_end ?? args.date_to;
  const hasFilter = observationTypes.length > 0 || observationConcepts.length > 0 || dateStart !== undefined
    || dateEnd !== undefined || (category !== undefined && category !== 'all');
  if (!query && !hasFilter) return { error: 'Search needs a query or a filter (type, obs_type, concepts, dateStart, dateEnd).' };
  const number = (value: unknown) => value === undefined || value === null || value === '' ? undefined : Number(value);
  const limit = number(args.limit);
  const offset = number(args.offset);
  return {
    project: typeof args.project === 'string' && args.project.trim() ? args.project.trim() : currentCheckout().primary,
    search: {
      ...(query ? { query } : {}),
      ...(limit !== undefined && Number.isFinite(limit) ? { limit: Math.min(100, Math.max(1, Math.floor(limit))) } : {}),
      ...(offset !== undefined && Number.isFinite(offset) ? { offset: Math.max(0, Math.floor(offset)) } : {}),
      ...(orderBy ? { orderBy: orderBy as 'relevance' | 'date_desc' | 'date_asc' } : {}),
      ...(dateStart !== undefined ? { dateStart: dateStart as string | number } : {}),
      ...(dateEnd !== undefined ? { dateEnd: dateEnd as string | number } : {}),
      ...(category ? { category } : {}),
      ...(observationTypes.length ? { observationTypes } : {}),
      ...(observationConcepts.length ? { observationConcepts } : {}),
      ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource as string | null) } : {}),
    },
  };
}

/**
 * dumb_search's three steps over the server (search, timeline, selected
 * details), in the contract the worker's ProgressiveMemorySearch implements.
 * The project is the server project of `project`; rows carry their folder label.
 */
function serverProgressiveBackend(runtime: ServerRuntimeContext, project: string): ProgressiveBackend {
  type Row = { id: string; content?: string; kind?: unknown; metadata?: unknown; createdAtEpoch?: unknown };
  const meta = (row: Row) => (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<string, unknown>;
  const toIndex = (row: Row): MemoryIndexRow => {
    const data = meta(row);
    const title = typeof data.title === 'string' && data.title.trim() ? data.title
      : typeof data.request === 'string' && data.request.trim() ? data.request
      : String(row.content ?? '').split('\n')[0] ?? '';
    return {
      id: String(row.id),
      kind: row.kind === 'summary' ? 'summary' : 'observation',
      project: typeof data.project === 'string' && data.project ? data.project : project,
      title,
      createdAt: typeof row.createdAtEpoch === 'number' ? row.createdAtEpoch : null,
      type: typeof row.kind === 'string' ? row.kind : null,
    };
  };
  return {
    async search({ query, limit }) {
      const response = await runtime.client.searchObservations({ projectId: runtime.projectId, query, limit: Math.max(limit, 100) });
      return (response.observations ?? []).map(row => toIndex(row as Row));
    },
    async timeline({ anchor, depthBefore, depthAfter }) {
      const response = await runtime.client.timelineObservations({ projectId: runtime.projectId, anchorId: anchor.id, depthBefore, depthAfter });
      return (response.observations ?? []).map(row => toIndex(row as Row));
    },
    async fetch(refs) {
      if (refs.length === 0) return [];
      const response = await runtime.client.selectedObservations({ projectId: runtime.projectId, ids: refs.map(ref => ref.id) });
      return (response.observations ?? []).map(row => {
        const index = toIndex(row as Row);
        const { text, truncated } = projectMemoryContent({ ...meta(row as Row), narrative: meta(row as Row).narrative ?? (row as Row).content });
        return { ...index, content: text, truncated };
      });
    },
  };
}

const SERVER_CORPUS_TIMEOUT_MS = 15 * 60_000;
const SERVER_CORPUS_PURPOSE: Record<'build' | 'list' | 'prime' | 'query' | 'rebuild' | 'reprime', McpTextPurpose> = {
  build: 'corpus-build', rebuild: 'corpus-build', list: 'corpus-list', prime: 'corpus-prime', reprime: 'corpus-prime', query: 'corpus-query',
};

/**
 * A corpus tool in server runtime: one `worker-service corpus-server` run
 * (Bun, which the corpus agent needs) reads the observations from the server
 * and keeps the corpus on this machine; no worker is started. prime and query
 * spend on the account the corpus-agent setting chooses, only on this call.
 */
async function runServerCorpus(op: keyof typeof SERVER_CORPUS_PURPOSE, args: Record<string, unknown>) {
  const runtimePath = resolveWorkerRuntimePath();
  // The worker-service beside this MCP server is the same build, so it knows corpus-server.
  const ownScript = resolve(mcpServerDir, 'worker-service.cjs');
  const scriptPath = existsSync(ownScript) ? ownScript : resolveWorkerScriptPath();
  if (!runtimePath || !scriptPath) return mcpTextResult('Corpus tools need Bun and the plugin\'s worker-service script; neither was found.', true);
  const outcome = await new Promise<{ status: number; body: Record<string, unknown> } | null>(resolve => {
    const child = spawn(runtimePath, [scriptPath, 'corpus-server'], { stdio: ['pipe', 'pipe', 'ignore'], env: sanitizeEnv(process.env) });
    let stdout = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, SERVER_CORPUS_TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.trim().split('\n').pop() ?? '';
      try { resolve(JSON.parse(line)); } catch { resolve(null); }
    });
    child.stdin.end(JSON.stringify({ op, cwd: getRequestCwd(), args }));
  });
  if (!outcome) return mcpTextResult('The corpus operation did not finish; retry it.', true);
  if (outcome.status !== 200) {
    const body = outcome.body ?? {};
    return mcpTextResult([body.error, body.fix].filter(value => typeof value === 'string').join('\n') || `Corpus ${op} failed (${outcome.status}).`, true);
  }
  return formatMcpPayload(SERVER_CORPUS_PURPOSE[op], outcome.body);
}

/** work_state_write in server runtime: the row goes to the server project this checkout's hooks write to. */
async function serverWorkStateWrite(args: { list?: unknown; fields?: unknown }) {
  const cwd = getRequestCwd();
  const checkout = getProjectContext(cwd);
  if (isProjectExcluded(cwd, loadFromFileOnce().CLAUDE_MEM_EXCLUDED_PROJECTS)) {
    return mcpTextResult('Not saved: this project is excluded from claude-mem (CLAUDE_MEM_EXCLUDED_PROJECTS).');
  }
  const list = typeof args?.list === 'string' ? args.list.trim() : '';
  const fields = (args?.fields ?? {}) as Record<string, string | number | boolean | null>;
  if (!list) return mcpTextResult('Not saved: "list" is required.', true);
  // Answered here as the worker answers it; the server checks the same rule.
  const refusal = workStateWriteRefusal(list, fields);
  if (refusal) return mcpTextResult(refusal.message, true);
  const runtime = serverContextForProject(checkout.primary);
  if (!runtime) return mcpTextResult(serverConfigIncompleteText('work_state_write'), true);
  try {
    const { entries } = await runtime.client.appendWorkStateEntry({ projectId: runtime.projectId, list, fields });
    return mcpTextResult(workStateWriteReply(toWorkStateEntries(entries ?? [], checkout.primary), list, checkout.primary, Date.now()));
  } catch (error) {
    return workStateServerError(error);
  }
}

/** work_state_read in server runtime. */
async function serverWorkStateRead(args: { list?: unknown; includeClosed?: unknown }) {
  const checkout = getProjectContext(getRequestCwd());
  const list = typeof args?.list === 'string' && args.list.trim() ? args.list.trim() : undefined;
  const runtime = serverContextForProject(checkout.primary);
  if (!runtime) return mcpTextResult(serverConfigIncompleteText('work_state_read'), true);
  try {
    const { entries } = await runtime.client.readWorkStateEntries({ projectId: runtime.projectId, ...(list ? { list } : {}) });
    return formatWorkStateMcpResponse(workStateReadReply(toWorkStateEntries(entries ?? [], checkout.primary), {
      list,
      includeClosed: args?.includeClosed === true,
      project: checkout.primary,
      nowEpoch: Date.now(),
    }));
  } catch (error) {
    return workStateServerError(error);
  }
}

const handleObservationGenerationStatus = wrapHandler('observation_generation_status', async (args: ObservationGenerationStatusArgs) => {
  const ctx = requireServerForObservationTool('observation_generation_status');
  const jobId = (args?.jobId ?? args?.job_id ?? '').trim();
  if (!jobId) {
    throw new Error('observation_generation_status: "jobId" is required');
  }
  const response = await ctx.client.getJobStatus(jobId);
  return formatMcpPayload('job', response);
});

async function ensureWorkerConnection(): Promise<boolean> {
  if (await verifyWorkerConnection()) {
    return true;
  }

  logger.warn('SYSTEM', 'Worker not available, attempting auto-start for MCP client');

  errorIfWorkerScriptMissing();

  try {
    const port = getWorkerPort();
    const result = await ensureWorkerStarted(port, WORKER_SCRIPT_PATH);
    if (result === 'dead') {
      logger.error(
        'SYSTEM',
        'Worker auto-start failed — MCP tools that require the worker (search, timeline, get_observations) will fail until the worker is running. Check earlier log lines for the specific failure reason (Bun not found, missing worker bundle, port conflict, etc.).'
      );
    }
    return result !== 'dead';
  } catch (error: unknown) {
    logger.error(
      'SYSTEM',
      'Worker auto-start threw — MCP tools that require the worker (search, timeline, get_observations) will fail until the worker is running.',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
    return false;
  }
}

// Plan mode lets an MCP tool run without a prompt only when it declares
// readOnlyHint (#3483). The File Read Gate sends Claude to smart_outline,
// smart_unfold and get_observations, so those must work in plan mode too.
// Tools that write (work_state_write, observation_add, the corpus builders and
// query_corpus, which appends to the corpus session) keep prompting.
const READ_ONLY_TOOL_ANNOTATIONS = { readOnlyHint: true } as const;

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
  annotations?: any;
  handler: (args: any) => any;
}

const tools: McpToolDefinition[] = [
  {
    name: 'dumb_search',
    description: 'Dumb search (optional): Doesn’t reason about the results. Fast, but shallow. Use Smart for reliable recall. This one-call lookup picks records by title word overlap, adds nearby context, and returns up to maxDetails records. Smart search is the default mem-search workflow: search → timeline → selected get_observations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, up to 500 characters.' },
        project: { type: 'string', description: 'Optional project filter.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Index result count, default 20.' },
        maxDetails: { type: 'integer', minimum: 1, maximum: 5, description: 'Maximum full details, default 3.' },
        depthBefore: { type: 'integer', minimum: 0, maximum: 3, description: 'Context rows before each selected anchor, default 2.' },
        depthAfter: { type: 'integer', minimum: 0, maximum: 3, description: 'Context rows after each selected anchor, default 2.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => {
      try {
        if (selectRuntime() === 'server') {
          const project = typeof args?.project === 'string' && args.project.trim() ? args.project.trim() : currentCheckout().primary;
          const runtime = serverContextForProject(project);
          if (!runtime) throw new ProgressiveSearchError('unsupported_runtime', serverConfigIncompleteText('dumb_search'));
          const result = await new ProgressiveSearch(serverProgressiveBackend(runtime, project)).run(args ?? {});
          return progressiveSearchToolResult(result);
        }
        const body = withCheckoutProjects(args ?? {}, currentCheckout());
        const response = await withWorkerRestartOnRefusedConnection(() => workerHttpRequest('/api/dumb-search', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }), startWorkerAfterRefusedConnection);
        if (!response.ok) throw new Error(`Worker API error (${response.status})`);
        const result = await response.json() as WorkerToolResult;
        return {
          content: result.content.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => ({ type: 'text' as const, text: item.text })),
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (error) {
        logger.warn('SYSTEM', 'dumb_search failed', undefined, error instanceof Error ? error : new Error(String(error)));
        return progressiveSearchToolError(error);
      }
    },
  },
  {
    name: 'save_memory',
    description: 'Save an explicit durable note, decision, correction or handoff into claude-mem (the local store, or the server in server runtime). Use this for your own note taking after searching memory for duplicates. Include project when the note belongs to a specific project.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Durable memory text.' },
        title: { type: 'string', description: 'Concise searchable title.' },
        project: { type: 'string', description: 'Project receiving the note; defaults to the active checkout.' },
        metadata: { type: 'object', additionalProperties: true, description: 'Optional provenance or source metadata.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: async (args: any) => {
      if (selectRuntime() === 'server') return serverSaveMemory(args ?? {});
      return callWorker('/api/memory/save', { body: { ...args, project: args?.project || currentCheckout().primary } });
    },
  },
  {
    name: 'important_workflow',
    description: `SMART SEARCH (DEFAULT): Use the mem-search skill in three steps; no auto or guided modes. In server runtime, search, timeline, and get_observations use the configured server project.
1. search(query) → Get index with IDs (~50-100 tokens/result)
2. timeline(anchor=ID) → Get context around interesting results
3. get_observations([IDs]) → Fetch selected details ONLY for filtered IDs
Exceptional follow-up: get_tool_uses([IDs]) for raw tool_input/tool_response, ONLY when the summary is not enough
NEVER fetch full details without filtering first: an index row is ~50-100 tokens, about a tenth of a ~500-1,000-token record, so filtering decides how many records you fetch, not how large each one is.`,
    inputSchema: {
      type: 'object',
      properties: {}
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    // One workflow in both runtimes: the server takes the same tools and filters.
    handler: async () => ({
      content: [{
        type: 'text' as const,
        text: `# Smart Search (Default)

Use the original three-step mem-search workflow. Reason about the index and timeline before selecting full details. No auto or guided modes.

**3-Layer Pattern (ALWAYS follow this):**

1. **Search** - Get index of results with IDs
   \`search(query="...", limit=20, project="...")\`
   Returns: Table with IDs, titles, dates (~50-100 tokens/result)

2. **Timeline** - Get context around interesting results
   \`timeline(anchor=<ID>, depth_before=3, depth_after=3)\`
   Returns: Chronological context showing what was happening

3. **Fetch** - Get selected details ONLY for relevant IDs
   \`get_observations(ids=[...])\`  # ALWAYS batch for 2+ items
   Returns: Selected useful fields, with any shortening marked (~500-1000 tokens/result)

**Exceptional follow-up: raw tool I/O** - Last resort, when the observation summary does not answer the question
   \`get_tool_uses(ids=[...])\`
   Returns: The original tool_input / tool_response bodies (UNSUMMARIZED — can be thousands of tokens each)

**Why:** an index row is ~50-100 tokens, about a tenth of a ~500-1,000-token record, so filtering decides how many records you fetch, not their size. Never fetch full details without filtering first, and never reach for raw tool I/O before the three-step workflow.

Optional Dumb search: \`dumb_search({query, project})\`. Doesn’t reason about the results. Fast, but shallow. Use Smart for reliable recall.`
      }]
    })
  },
  {
    name: 'search',
    description: 'Smart search (default), step 1: search memory for an index with IDs. Review it, use timeline for context, then get_observations only for selected IDs. Params: query, limit, project, platformSource, type, obs_type, dateStart, dateEnd, offset, orderBy',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        deep: { type: 'boolean', description: 'Opt-in local raw-tool search when observations have no matches. Requires CLAUDE_MEM_TOOL_USES_SEARCH_ENABLED; first page only. Results use T IDs; fetch selected numeric IDs with get_tool_uses.' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        project: { type: 'string', description: 'Worker project name' },
        projectId: { type: 'string', description: 'Server project ID; defaults to the configured server project' },
        platformSource: { type: 'string', description: "Filter by platform source (e.g. claude, codex, cursor) — restricts results to that agent's own memory" },
        type: { type: 'string', description: "Document category to search: 'observations', 'sessions', or 'prompts' (default: all). Any other value is treated as an observation-type filter (alias for obs_type)." },
        obs_type: { type: 'string', description: 'Filter observations by their type (e.g. bugfix, feature). Comma-separated for multiple.' },
        dateStart: { type: 'string', description: 'Start date filter (ISO)' },
        dateEnd: { type: 'string', description: 'End date filter (ISO)' },
        offset: { type: 'number', description: 'Pagination offset' },
        orderBy: { type: 'string', description: 'Sort order: date_desc or date_asc' }
      },
      additionalProperties: true
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => {
      if (selectRuntime() === 'server') {
        const request = serverSearchRequest(args ?? {});
        if ('error' in request) return mcpTextResult(request.error, true);
        const runtime = serverContextForProject(request.project);
        if (!runtime) return mcpTextResult(serverConfigIncompleteText('search'), true);
        try {
          const projectIds = args.projectId ? undefined : checkoutProjectIds(runtime, args.project);
          const projectId = typeof args.projectId === 'string' && args.projectId.trim() ? args.projectId : runtime.projectId;
          const found = await runtime.client.searchObservations({
            ...request.search,
            projectId,
            ...(projectIds ? { projectIds } : {}),
          });
          // deep: with no observation match on the first page, raw tool calls
          // that contain the query (the worker's tool_uses_fts fallback).
          if (args.deep === true && (found.observations ?? []).length === 0 && !request.search.offset && request.search.query) {
            const raw = await runtime.client.searchToolUses({
              projectId, ...(projectIds ? { projectIds } : {}), query: request.search.query, limit: 10,
              ...(request.search.platformSource !== undefined ? { platformSource: request.search.platformSource } : {}),
            });
            if ((raw.toolUses ?? []).length > 0) {
              const formatted = formatMcpPayload('tool-uses', raw);
              return mcpTextResult(`No observation matched; raw tool calls containing the query (deep):\n\n${formatted.content[0].text}`);
            }
          }
          return formatMcpPayload('server-search', found);
        } catch (error) {
          return workStateServerError(error);
        }
      }
      return await callWorker('/api/search', { query: withCheckoutProjects(args ?? {}, currentCheckout()) });
    }
  },
  {
    name: 'timeline',
    description: 'Step 2: Get context around results. Params: anchor (observation ID) OR query (finds anchor automatically), depth_before, depth_after, project',
    inputSchema: {
      type: 'object',
      properties: {
        anchor: { type: ['number', 'string'], description: 'Observation ID to center the timeline around (string ID in server runtime)' },
        query: { type: 'string', description: 'Query to find anchor automatically' },
        depth_before: { type: 'number', description: 'Items before anchor (default 3)' },
        depth_after: { type: 'number', description: 'Items after anchor (default 3)' },
        project: { type: 'string', description: 'Worker project name' },
        projectId: { type: 'string', description: 'Server project ID; defaults to the configured server project' }
      },
      additionalProperties: true
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => {
      if (selectRuntime() === 'server') {
        const anchor = args?.anchor !== undefined && args.anchor !== null ? String(args.anchor).trim().replace(/^#/, '') : '';
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (Boolean(anchor) === Boolean(query)) return mcpTextResult('Timeline needs either an anchor (an ID from search, or a date/time) or a query, not both.', true);
        const runtime = serverContextForProject(typeof args?.project === 'string' && args.project.trim() ? args.project.trim() : currentCheckout().primary);
        if (!runtime) return mcpTextResult(serverConfigIncompleteText('timeline'), true);
        // A moment (ISO date or epoch ms) anchors by time, as the worker's timeline does.
        const anchorIsTime = /^\d{4}-\d{2}-\d{2}/.test(anchor) || /^\d{10,}$/.test(anchor);
        const depth = (value: unknown) => value === undefined ? undefined : Math.min(50, Math.max(0, Math.floor(Number(value))));
        try {
          const projectIds = args.projectId ? undefined : checkoutProjectIds(runtime, args.project);
          return formatMcpPayload('server-timeline', await runtime.client.timelineObservations({
            projectId: args.projectId || runtime.projectId,
            ...(projectIds ? { projectIds } : {}),
            ...(query ? { query } : anchorIsTime ? { anchorTime: anchor } : { anchorId: anchor }),
            ...(args.depth_before !== undefined ? { depthBefore: depth(args.depth_before) } : {}),
            ...(args.depth_after !== undefined ? { depthAfter: depth(args.depth_after) } : {}),
            ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource) } : {}),
          }));
        } catch (error) {
          return workStateServerError(error);
        }
      }
      return await callWorker('/api/timeline', { query: withCheckoutProjects(args ?? {}, currentCheckout()) });
    }
  },
  {
    name: 'get_observations',
    description: 'Step 3: Fetch selected useful details for the IDs chosen after reviewing the index and timeline. Any shortening is marked. Params: ids (required), orderBy, limit, project (worker) or projectId (server). At most 100 ids per call; split larger selections across several calls.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          maxItems: 100,
          items: { type: ['number', 'string'] },
          description: 'Array of selected observation IDs to fetch (at most 100; split larger selections). String IDs in server runtime.'
        },
        projectId: { type: 'string', description: 'Server project ID; defaults to the configured server project' }
      },
      required: ['ids'],
      additionalProperties: true
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => {
      if (selectRuntime() === 'server') {
        if (!Array.isArray(args?.ids) || !args.ids.length || args.ids.some((id: unknown) => (typeof id !== 'string' && typeof id !== 'number') || !String(id).trim())) return mcpTextResult('Select nonempty observation IDs from search and timeline.', true);
        if (args?.orderBy !== undefined && args.orderBy !== 'date_desc' && args.orderBy !== 'date_asc') return mcpTextResult('orderBy must be date_desc or date_asc.', true);
        const runtime = serverContextForProject(typeof args?.project === 'string' && args.project.trim() ? args.project.trim() : currentCheckout().primary);
        if (!runtime) return mcpTextResult(serverConfigIncompleteText('get_observations'), true);
        try {
          const projectIds = args.projectId ? undefined : checkoutProjectIds(runtime, args.project);
          return formatMcpPayload('observations', await runtime.client.selectedObservations({
            projectId: args.projectId || runtime.projectId,
            ...(projectIds ? { projectIds } : {}),
            ids: args.ids.map((id: unknown) => String(id).trim().replace(/^#/, '')),
            ...(args.orderBy ? { orderBy: args.orderBy } : {}),
            ...(args.limit !== undefined ? { limit: Math.min(100, Math.max(1, Math.floor(Number(args.limit)))) } : {}),
            ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource) } : {}),
          }));
        } catch (error) {
          return workStateServerError(error);
        }
      }
      return await callWorker('/api/observations/batch', { body: withCheckoutProjects(args ?? {}, currentCheckout()) });
    }
  },
  {
    name: 'get_tool_uses',
    description: 'Exceptional follow-up (raw tool I/O, rarely needed): fetch the ORIGINAL tool_input/tool_response for tool calls you already identified. Requires ids — run search/timeline/get_observations first and pass only the ids you actually need; these payloads are large and unsummarized. ids accept numeric tool_uses ids or tool_use_id strings. Params: ids (required), limit, project, contentSessionId. At most 100 ids per call; split larger selections.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          maxItems: 100,
          items: { type: ['number', 'string'] },
          description: 'Tool-use ids to fetch (required, at most 100; split larger selections). Numeric tool_uses.id or opaque tool_use_id strings.'
        },
        limit: { type: 'number', description: 'Max rows to return (default 100, max 200)' },
        project: { type: 'string', description: 'Filter by project name' },
        contentSessionId: { type: 'string', description: 'Filter to one content session' }
      },
      required: ['ids'],
      additionalProperties: true
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => {
      if (selectRuntime() === 'server') {
        if (!Array.isArray(args?.ids) || !args.ids.length) return mcpTextResult('Select tool-call or observation IDs first (search, timeline, get_observations).', true);
        const runtime = serverContextForProject(typeof args?.project === 'string' && args.project.trim() ? args.project.trim() : currentCheckout().primary);
        if (!runtime) return mcpTextResult(serverConfigIncompleteText('get_tool_uses'), true);
        try {
          return formatMcpPayload('tool-uses', await runtime.client.toolUses({
            projectId: args.projectId || runtime.projectId,
            ids: args.ids.slice(0, 100).map((id: unknown) => String(id).trim().replace(/^#/, '')),
            ...(args.limit !== undefined ? { limit: Math.min(200, Math.max(1, Math.floor(Number(args.limit)))) } : {}),
            ...(typeof args.contentSessionId === 'string' ? { contentSessionId: args.contentSessionId } : {}),
            ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource) } : {}),
          }));
        } catch (error) {
          return workStateServerError(error);
        }
      }
      return await callWorker('/api/tool-uses/batch', { body: withCheckoutProjects(args ?? {}, currentCheckout()) });
    }
  },
  {
    name: 'work_state_write',
    description: 'Your canonical to-do list and working state for this project, kept across sessions: whatever is still open is shown at the start of every session. Each call appends one entry to a list. To-do item: fields {"task": "<name>", "status": "todo" | "doing" | "done" | "dropped", ...details}. State on the list itself: any other fields (the latest value of each key wins; null clears a key; "status": "done" closes the list). Returns what is still open in the list. Params: list (required), fields (required).',
    inputSchema: {
      type: 'object',
      properties: {
        list: { type: 'string', description: 'The to-do list or tracked thing this entry belongs to, e.g. "release" or "auth-refactor"' },
        fields: {
          type: 'object',
          description: 'Keys to set. Include "task" to update a to-do item. Values are strings, numbers, booleans, or null to clear a key.',
          additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
        },
      },
      required: ['list', 'fields'],
      additionalProperties: false,
    },
    handler: async (args: any) => selectRuntime() === 'server' ? serverWorkStateWrite(args) : callWorker('/api/work-state/entries', {
      body: { cwd: getRequestCwd(), list: args?.list, fields: args?.fields },
      text: true,
    }),
  },
  {
    name: 'work_state_read',
    description: "Read this project's to-do lists and working state written with work_state_write: every open item, or one list, with done and dropped items when includeClosed is true. Params: list, includeClosed.",
    inputSchema: {
      type: 'object',
      properties: {
        list: { type: 'string', description: 'Read only this list' },
        includeClosed: { type: 'boolean', description: 'Also show done and dropped items and closed lists' },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => selectRuntime() === 'server' ? serverWorkStateRead(args) : callWorker('/api/work-state', {
      query: { cwd: getRequestCwd(), list: args?.list, includeClosed: args?.includeClosed },
      text: true,
    }),
  },
  {
    name: 'team_brief',
    description: "TeamBrain brief for a project: where teammates' work collides with yours, recent plans and decisions, who is active in it now, and work delegated to you. Params: project (defaults to this checkout).",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name; defaults to this checkout' },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => callWorker('/api/teambrain/brief', {
      query: { project: args?.project || currentCheckout().primary },
      text: true,
    }),
  },
  {
    name: 'team_search',
    description: "Search what your team shared with TeamBrain: teammates' observations, plans and decisions across the projects they share. Params: query (required), limit.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, up to 500 characters' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => callWorker('/api/teambrain/search', {
      body: { query: args?.query, limit: args?.limit },
      text: true,
    }),
  },
  {
    name: 'session_start_context',
    description: 'Render the exact worker-mode SessionStart context for a project. Calls /api/context/inject and returns the same text hooks inject at startup. Params: project OR projects, platformSource, full, colors.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, e.g. claude-mem/night-parsnip' },
        projects: {
          oneOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'string' },
          ],
          description: 'Project chain for context injection. Array or comma-separated string; last project is treated as primary.',
        },
        platformSource: { type: 'string', description: 'Optional platform source filter, e.g. claude, codex, cursor' },
        full: { type: 'boolean', description: 'When true, request full context instead of configured limits' },
        colors: { type: 'boolean', description: 'When true, request human terminal-color formatting' },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => handleSessionStartContext(args ?? {}),
  },
  // Phase 8 — observation_* tools backed by server REST core.
  {
    name: 'observation_add',
    description: 'Insert a manual observation directly into server storage. Calls /v1/memories — does NOT enqueue generation. Server runtime only. Params: content (required), projectId (optional, falls back to settings), serverSessionId, kind, metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id (falls back to CLAUDE_MEM_SERVER_PROJECT_ID)' },
        serverSessionId: { type: 'string', description: 'Optional server_session_id to attach the observation to' },
        kind: { type: 'string', description: 'Observation kind (default: manual)' },
        content: { type: 'string', description: 'Observation content (required)' },
        metadata: { type: 'object', description: 'Free-form metadata object', additionalProperties: true },
      },
      required: ['content'],
      additionalProperties: false,
    },
    handler: async (args: any) => handleObservationAdd(args ?? {}),
  },
  {
    name: 'observation_record_event',
    description: 'Record an agent event into the server. Calls /v1/events — server inserts the event row, the outbox row, and enqueues a generation job atomically. Server runtime only.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        eventType: { type: 'string', description: 'Event type (required), e.g. PostToolUse, UserPromptSubmit' },
        sourceType: { type: 'string', enum: ['hook', 'worker', 'provider', 'server', 'api'] },
        serverSessionId: { type: 'string' },
        contentSessionId: { type: 'string' },
        memorySessionId: { type: 'string' },
        platformSource: { type: 'string', description: 'Optional platform source for session linkage and event scoping' },
        payload: { description: 'Event payload (any JSON value)' },
        occurredAtEpoch: { type: 'number', description: 'Unix epoch millis (defaults to now)' },
        generate: { type: 'boolean', description: 'If false, skip generation job (default: true)' },
      },
      required: ['eventType'],
      additionalProperties: false,
    },
    handler: async (args: any) => handleObservationRecordEvent(args ?? {}),
  },
  {
    name: 'observation_search',
    description: 'Search generated observations by keyword (Postgres full-text) and, when the server has search by meaning (pgvector, CLAUDE_MEM_SERVER_VECTOR_SEARCH), by meaning (embedding similarity), fused by reciprocal rank. A natural-language question works. Search by meaning has no relevance cutoff, so it always returns the nearest matches; keyword-only search returns only observations containing a query term. Calls /v1/search. Server runtime only. Params: query (required), projectId (optional), platformSource, limit (default 20, max 100).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        query: { type: 'string', description: 'Search query (required)' },
        platformSource: { type: 'string', description: 'Optional platform source filter, e.g. claude, codex, cursor' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => handleObservationSearch(args ?? {}),
  },
  {
    name: 'observation_context',
    description: 'Get top-N relevant observations for context injection. Returns matched observations AND a pre-joined context string suitable for prompt injection. Calls /v1/context. Server runtime only. Omit "query" for recency-ordered "recent" context instead of a relevance-ranked search.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        query: { type: 'string', description: 'Optional search query. Omit for recency-ordered recent context.' },
        platformSource: { type: 'string', description: 'Optional platform source filter, e.g. claude, codex, cursor' },
        limit: { type: 'number', description: 'Max observations (default 10 with a query, 50 without; max 200)' },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => handleObservationContext(args ?? {}),
  },
  {
    name: 'observation_generation_status',
    description: 'Look up the status of an observation generation job by id. Calls /v1/jobs/:id. Server runtime only. Returns a concise job receipt.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Generation job id (required)' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => handleObservationGenerationStatus(args ?? {}),
  },
  {
    name: 'smart_search',
    description: 'Search codebase for symbols, functions, classes using tree-sitter AST parsing. Returns folded structural views with token counts. Use path parameter to scope the search.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term — matches against symbol names, file names, and file content'
        },
        path: {
          type: 'string',
          description: 'Root directory to search (default: current working directory)'
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return (default: 20)'
        },
        file_pattern: {
          type: 'string',
          description: 'Substring filter for file paths (e.g. ".ts", "src/services")'
        }
      },
      required: ['query']
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => {
      const rootDir = await resolveWithinWorkspace(args.path || getRequestCwd(), getRequestCwd());
      // Check the CLI before any parsing (#4758): with a broken install,
      // symbol extraction stalls on build/query timeouts, so skip it up
      // front while keeping path matches, which need no tree-sitter.
      const unavailableCli = treeSitterCliUnavailableMessage();
      const result = await searchCodebase(rootDir, args.query, {
        maxResults: args.max_results || 20,
        filePattern: args.file_pattern,
        skipSymbolExtraction: unavailableCli !== null,
      });
      const formatted = formatSearchResults(result, args.query);
      // Path matches need no tree-sitter, so a broken CLI only degrades symbol
      // extraction: keep the results and warn instead of blocking the search.
      const text = unavailableCli
        ? `Note: symbol extraction is unavailable (${unavailableCli}); path matches below are unaffected.\n\n${formatted}`
        : formatted;
      return {
        content: [{ type: 'text' as const, text }]
      };
    }
  },
  {
    name: 'smart_unfold',
    description: 'Expand a specific symbol (function, class, method) from a file. Returns the full source code of just that symbol. Use after smart_search or smart_outline to read specific code.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the source file'
        },
        symbol_name: {
          type: 'string',
          description: 'Name of the symbol to unfold (function, class, method, etc.)'
        }
      },
      required: ['file_path', 'symbol_name']
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => {
      const filePath = await resolveWithinWorkspace(args.file_path, getRequestCwd());
      const content = await readFile(filePath, 'utf-8');
      const unavailableCli = treeSitterCliUnavailableMessage();
      if (unavailableCli) {
        return {
          content: [{ type: 'text' as const, text: `Could not parse ${args.file_path}: ${unavailableCli}.` }]
        };
      }
      const unfolded = unfoldSymbol(content, filePath, args.symbol_name);
      if (unfolded) {
        return {
          content: [{ type: 'text' as const, text: unfolded }]
        };
      }
      const parsed = parseFile(content, filePath);
      if (parsed.symbols.length > 0) {
        const available = formatAvailableSymbols(parsed, args.symbol_name);
        return {
          content: [{
            type: 'text' as const,
            text: `Symbol "${args.symbol_name}" not found in ${args.file_path}.\n\nAvailable symbols:\n${available}`
          }]
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: `Could not parse ${args.file_path}. File may be unsupported or empty.`
        }]
      };
    }
  },
  {
    name: 'smart_outline',
    description: 'Get structural outline of a file — shows all symbols (functions, classes, methods, types) with signatures but bodies folded. Much cheaper than reading the full file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the source file'
        }
      },
      required: ['file_path']
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => {
      const filePath = await resolveWithinWorkspace(args.file_path, getRequestCwd());
      const content = await readFile(filePath, 'utf-8');
      const unavailableCli = treeSitterCliUnavailableMessage();
      if (unavailableCli) {
        return {
          content: [{ type: 'text' as const, text: `Could not parse ${args.file_path}: ${unavailableCli}.` }]
        };
      }
      const parsed = parseFile(content, filePath);
      if (parsed.symbols.length > 0) {
        return {
          content: [{ type: 'text' as const, text: formatFoldedView(parsed) }]
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: `Could not parse ${args.file_path}. File may use an unsupported language or be empty.`
        }]
      };
    }
  },
  {
    name: 'build_corpus',
    description: 'Build a knowledge corpus from filtered observations. Creates a queryable knowledge agent. Params: name (required), description, project, types (comma-separated), concepts (comma-separated), files (comma-separated), query, dateStart, dateEnd, limit',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Corpus name (used as filename)' },
        description: { type: 'string', description: 'What this corpus is about' },
        project: { type: 'string', description: 'Filter by project' },
        types: { type: 'string', description: 'Comma-separated observation type IDs, such as decision, bugfix, or types from other modes' },
        concepts: { type: 'string', description: 'Comma-separated concepts to filter by' },
        files: { type: 'string', description: 'Comma-separated file paths to filter by' },
        query: { type: 'string', description: 'Semantic search query' },
        dateStart: { type: 'string', description: 'Start date (ISO format)' },
        dateEnd: { type: 'string', description: 'End date (ISO format)' },
        limit: { type: 'number', description: 'Maximum observations (default 500)' }
      },
      required: ['name'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      if (selectRuntime() === 'server') return runServerCorpus('build', args ?? {});
      return await callWorker('/api/corpus', { body: args, streamCorpusProgress: true });
    }
  },
  {
    name: 'list_corpora',
    description: 'List all knowledge corpora with their stats and priming status',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    handler: async (args: any) => {
      if (selectRuntime() === 'server') return runServerCorpus('list', args ?? {});
      return await callWorker('/api/corpus', { query: args });
    }
  },
  {
    name: 'prime_corpus',
    description: 'Prime a knowledge corpus — creates an AI session loaded with the corpus knowledge. Must be called before query_corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the corpus to prime' }
      },
      required: ['name'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { name, ...rest } = args;
      if (typeof name !== 'string' || name.trim() === '') throw new Error('Missing required argument: name');
      if (selectRuntime() === 'server') return runServerCorpus('prime', { ...rest, name });
      return await callWorker(`/api/corpus/${encodeURIComponent(name)}/prime`, { body: rest, streamCorpusProgress: true });
    }
  },
  {
    name: 'query_corpus',
    description: 'Ask a question to a primed knowledge corpus. The corpus must be primed first with prime_corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the corpus to query' },
        question: { type: 'string', description: 'The question to ask' }
      },
      required: ['name', 'question'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { name, ...rest } = args;
      if (typeof name !== 'string' || name.trim() === '') throw new Error('Missing required argument: name');
      if (selectRuntime() === 'server') return runServerCorpus('query', { ...rest, name });
      return await callWorker(`/api/corpus/${encodeURIComponent(name)}/query`, { body: rest, streamCorpusProgress: true });
    }
  },
  {
    name: 'rebuild_corpus',
    description: 'Rebuild a knowledge corpus from its stored filter — re-runs the search to refresh with new observations. Does not re-prime the session. Refuses and keeps the existing corpus if the rebuild would drop a large share of observations, unless force is set.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the corpus to rebuild' },
        force: { type: 'boolean', description: 'Accept a rebuild that shrinks the corpus significantly instead of keeping the existing one' }
      },
      required: ['name'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { name, ...rest } = args;
      if (typeof name !== 'string' || name.trim() === '') throw new Error('Missing required argument: name');
      if (selectRuntime() === 'server') return runServerCorpus('rebuild', { ...rest, name });
      return await callWorker(`/api/corpus/${encodeURIComponent(name)}/rebuild`, { body: rest, streamCorpusProgress: true });
    }
  },
  {
    name: 'reprime_corpus',
    description: 'Create a fresh knowledge agent session for a corpus, clearing prior Q&A context. Use when conversation has drifted or after rebuilding.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the corpus to reprime' }
      },
      required: ['name'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { name, ...rest } = args;
      if (typeof name !== 'string' || name.trim() === '') throw new Error('Missing required argument: name');
      if (selectRuntime() === 'server') return runServerCorpus('reprime', { ...rest, name });
      return await callWorker(`/api/corpus/${encodeURIComponent(name)}/reprime`, { body: rest, streamCorpusProgress: true });
    }
  }
];

function workStateEnabled(): boolean {
  return isWorkStateEnabled(loadFromFileOnce().CLAUDE_MEM_WORK_STATE_ENABLED);
}

function teamBrainJoined(): boolean {
  return teamBrainConnection(loadFromFileOnce()) !== null;
}

/**
 * One MCP Server. Over stdio there is exactly one; over HTTP every session gets its own.
 * `getCwd` returns the HTTP request's project directory. Stdio asks the client roots/list,
 * then uses the process launch directory or a verified PWD fallback from the plugin root.
 */
function createMcpServer(getCwd?: CwdResolver): Server {
  // How to use these tools: the work-state rule and the memory-use guidance.
  // They are sent here, at initialize, so the SessionStart context can be the
  // memory timeline alone. Each part follows the setting that turns it off.
  const workStateRuleIncluded = workStateEnabled();
  const instructions = mcpServerInstructions({
    runtime: selectRuntime(),
    workStateEnabled: workStateRuleIncluded,
    memoryInstructionsEnabled: loadFromFileOnce().CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED !== 'false',
  });
  const server = new Server(
    {
      name: 'claude-mem',
      version: packageVersion,
    },
    {
      capabilities: {
        tools: {},  // Exposes tools capability (handled by ListToolsRequestSchema and CallToolRequestSchema)
      },
      ...(instructions ? { instructions } : {}),
    }
  );
  server.oninitialized = () => spoolWorkStateMcpInstruction(workStateRuleIncluded);

  const stdioCwd = getCwd ? null : createStdioCwdResolver({ peer: server, pluginRoot: MCP_PLUGIN_ROOT });
  if (stdioCwd) server.setNotificationHandler(RootsListChangedNotificationSchema, async () => stdioCwd.markRootsStale());

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const advertisedTools = withoutUnjoinedTeamBrainTools(
      withoutDisabledWorkStateTools(getAdvertisedMcpToolsForRuntime(tools, selectRuntime()), workStateEnabled()),
      teamBrainJoined(),
    );
    return {
      tools: advertisedTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations
      }))
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = tools.find(t => t.name === request.params.name);

    if (!tool) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    if ((WORK_STATE_TOOL_NAMES as readonly string[]).includes(tool.name) && !workStateEnabled()) {
      const result = {
        content: [{ type: 'text' as const, text: 'Work state is turned off (CLAUDE_MEM_WORK_STATE_ENABLED=false).' }],
        isError: true
      };
      spoolWorkStateMcpResult(tool.name, result);
      return result;
    }

    if ((TEAMBRAIN_TOOL_NAMES as readonly string[]).includes(tool.name) && !teamBrainJoined()) {
      return {
        content: [{
          type: 'text' as const,
          text: 'TeamBrain is not set up on this install. Join a team with `npx claude-mem teambrain join <invite-link>`, or start one with `npx claude-mem teambrain start`.',
        }],
        isError: true
      };
    }

    try {
      const args = request.params.arguments || {};
      const cwd = getCwd ? getCwd(extra) : await stdioCwd!.resolve();
      const result = await runWithCwd(cwd, () => tool.handler(args));
      spoolWorkStateMcpResult(tool.name, result);
      return result;
    } catch (error: unknown) {
      logger.error('SYSTEM', 'Tool execution failed', { tool: request.params.name }, error instanceof Error ? error : new Error(String(error)));
      const result = {
        content: [{
          type: 'text' as const,
          text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
      spoolWorkStateMcpResult(tool.name, result);
      return result;
    }
  });

  return server;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let isCleaningUp = false;

function handleStdioClosed() {
  cleanup('stdio-closed');
}

function handleStdioError(error: Error) {
  logger.warn('SYSTEM', 'MCP stdio stream errored, shutting down', {
    message: error.message
  });
  cleanup('stdio-error');
}

function attachStdioLifecycle() {
  process.stdin.on('end', handleStdioClosed);
  process.stdin.on('close', handleStdioClosed);
  process.stdin.on('error', handleStdioError);
}

function detachStdioLifecycle() {
  process.stdin.off('end', handleStdioClosed);
  process.stdin.off('close', handleStdioClosed);
  process.stdin.off('error', handleStdioError);
}

function startParentHeartbeat() {
  if (process.platform === 'win32') return;

  const initialPpid = process.ppid;
  heartbeatTimer = setInterval(() => {
    if (process.ppid === 1 || process.ppid !== initialPpid) {
      logger.info('SYSTEM', 'Parent process died, self-exiting to prevent orphan', {
        initialPpid,
        currentPpid: process.ppid
      });
      cleanup();
    }
  }, HEARTBEAT_INTERVAL_MS);

  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function cleanup(reason: string = 'shutdown') {
  if (isCleaningUp) return;
  isCleaningUp = true;

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  detachStdioLifecycle();
  logger.info('SYSTEM', 'MCP server shutting down', { reason });
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

function detectMissingMarketplaceMarker(): void {
  const home = homedir();
  // Includes the installLocation Claude Code records for a marketplace added
  // from a local folder (`/plugin marketplace add <path>`).
  const marketplaceCandidates = marketplaceDirectoryCandidates(home);
  const present = marketplaceCandidates.some(p => p && existsSync(p));
  const cacheCandidates = [
    resolve(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem'),
    resolve(home, '.config', 'claude', 'plugins', 'cache', 'thedotmack', 'claude-mem'),
  ];
  const cachePresent = cacheCandidates.some(p => p && existsSync(p));
  const cacheRoot = cacheCandidates[0];

  if (!present && cachePresent) {
    logger.error(
      'SYSTEM',
      'claude-mem MCP started but no marketplace directory was found at ~/.claude/plugins/marketplaces/thedotmack, the XDG equivalent, or the thedotmack installLocation in known_marketplaces.json. The IDE plugin loader needs that directory to fire claude-mem hooks (SessionStart, PostToolUse, Stop, etc.). Without it, MCP search will work but no new memories will be captured. To self-heal, reinstall the plugin from the marketplace (/plugin marketplace add thedotmack/claude-mem, then /plugin install claude-mem@thedotmack).',
      { marketplaceCandidates, cacheRoot }
    );
  }
}

function checkMarketplaceMarker(): void {
  try {
    detectMissingMarketplaceMarker();
  } catch (error) {
    logger.warn('SYSTEM', 'checkMarketplaceMarker failed (non-fatal startup check)', undefined, error instanceof Error ? error : new Error(String(error)));
  }
}

function scheduleWorkerAutostart(): void {
  setTimeout(async () => {
    // Phase 8 — when CLAUDE_MEM_RUNTIME=server (or legacy `server-beta`,
    // normalized to `'server'` by selectRuntime), MCP must NOT auto-start
    // the worker. observation_* tools talk to the server runtime directly;
    // the legacy worker-backed tools (search/timeline/get_observations)
    // will simply error with a helpful message until the user switches
    // runtime.
    if (selectRuntime() === 'server') {
      logger.info('SYSTEM', 'MCP runtime=server — skipping worker auto-start', undefined, {});
      return;
    }
    const workerAvailable = await ensureWorkerConnection();
    if (!workerAvailable) {
      logger.error('SYSTEM', 'Worker not available', undefined, {});
      logger.error('SYSTEM', 'Tools will fail until Worker is started');
      logger.error('SYSTEM', 'Start Worker with: npm run worker:restart');
    } else {
      logger.info('SYSTEM', 'Worker available', undefined, {});
    }
  }, 0);
}

async function main() {
  // Built here, not at module load, so HTTP mode never creates this unused stdio server.
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  attachStdioLifecycle();
  await server.connect(transport);
  logger.info('SYSTEM', 'Claude-mem search server started');

  checkMarketplaceMarker();

  startParentHeartbeat();

  scheduleWorkerAutostart();
}

/**
 * HTTP mode (`--http`): one long-lived process serves many MCP clients. No stdin lifecycle
 * and no parent heartbeat, since no single client owns this process.
 */
async function mainHttp(options: McpHttpOptions) {
  const handle = await startMcpHttpServer({
    ...options,
    pluginRoot: options.pluginRoot ?? MCP_PLUGIN_ROOT,
    originPolicy: buildWorkerOriginPolicy(loadFromFileOnce()),
    localApiToken: readLocalApiToken(),
    createServer: createMcpServer,
  });
  logger.info('SYSTEM', 'Claude-mem MCP HTTP server started', { host: options.host, port: handle.port });

  checkMarketplaceMarker();

  scheduleWorkerAutostart();
}

// stdio keeps its historical exit code 0 on a fatal error. HTTP mode, including a
// refused --host or --port, exits 1 so a process manager reports the failure.
let fatalExitCode = 0;
async function start(): Promise<void> {
  let httpOptions: McpHttpOptions | null;
  try {
    httpOptions = parseHttpArgs(process.argv.slice(2), process.env);
  } catch (error) {
    fatalExitCode = 1; // parseHttpArgs only throws when HTTP mode was requested.
    throw error;
  }
  if (!httpOptions) return main();
  fatalExitCode = 1;
  return mainHttp(httpOptions);
}

start().catch((error) => {
  logger.error('SYSTEM', 'Fatal error', undefined, error);
  process.exit(fatalExitCode);
});
