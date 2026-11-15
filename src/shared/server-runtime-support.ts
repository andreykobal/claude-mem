/**
 * What each MCP tool and hook does in the server runtime
 * (CLAUDE_MEM_RUNTIME=server), in one place.
 *
 * The client has two backends. A tool or hook written against the local worker
 * used to get no server branch at all, and in server runtime it either failed
 * or quietly started a local worker that captured into a store no session
 * reads. Every tool and hook therefore names its server behaviour here; the
 * Records make a new one fail the typecheck until it does, and
 * tests/servers/server-runtime-parity.test.ts checks the built MCP server
 * advertises exactly these tools and never calls a local worker.
 */

export const SERVER_SUPPORT_KINDS = ['native', 'skip', 'gap'] as const;
export type ServerSupportKind = typeof SERVER_SUPPORT_KINDS[number];

/**
 * native: works in server runtime against the server.
 * skip: deliberately does nothing in server runtime; `why` says why that is right.
 * gap: not yet available in server runtime; `why` says what is missing.
 * Neither skip nor gap may call a local worker.
 */
export type ServerSupport =
  | { kind: 'native' }
  | { kind: 'skip'; why: string }
  | { kind: 'gap'; why: string };

export const MCP_TOOL_NAMES = [
  'dumb_search', 'save_memory', 'important_workflow', 'search', 'timeline', 'get_observations',
  'get_tool_uses', 'work_state_write', 'work_state_read', 'team_brief', 'team_search',
  'session_start_context', 'observation_add', 'observation_record_event', 'observation_search',
  'observation_context', 'observation_generation_status', 'smart_search', 'smart_unfold',
  'smart_outline', 'build_corpus', 'list_corpora', 'prime_corpus', 'query_corpus',
  'rebuild_corpus', 'reprime_corpus',
] as const;
export type McpToolName = typeof MCP_TOOL_NAMES[number];

const native = { kind: 'native' } as const;

export const MCP_TOOL_SERVER_SUPPORT: Record<McpToolName, ServerSupport> = {
  dumb_search: native,
  save_memory: native,
  important_workflow: native,
  search: native,
  timeline: native,
  get_observations: native,
  get_tool_uses: native,
  work_state_write: native,
  work_state_read: native,
  team_brief: { kind: 'skip', why: 'TeamBrain is the hosted cmem.ai service, not this server' },
  team_search: { kind: 'skip', why: 'TeamBrain is the hosted cmem.ai service, not this server' },
  session_start_context: native,
  observation_add: native,
  observation_record_event: native,
  observation_search: native,
  observation_context: native,
  observation_generation_status: native,
  smart_search: { kind: 'skip', why: 'reads source files on this machine; no memory backend involved' },
  smart_unfold: { kind: 'skip', why: 'reads source files on this machine; no memory backend involved' },
  smart_outline: { kind: 'skip', why: 'reads source files on this machine; no memory backend involved' },
  build_corpus: native,
  list_corpora: native,
  prime_corpus: native,
  query_corpus: native,
  rebuild_corpus: native,
  reprime_corpus: native,
};

export const HOOK_EVENT_NAMES = [
  'context', 'session-init', 'session-init-context', 'observation', 'summarize', 'session-end',
  'subagent-stop', 'user-message', 'file-edit', 'file-context', 'post-compact', 'subagent-context',
] as const;
export type HookEventName = typeof HOOK_EVENT_NAMES[number];

export const HOOK_SERVER_SUPPORT: Record<HookEventName, ServerSupport> = {
  context: native,
  'session-init': native,
  'session-init-context': native,
  observation: native,
  summarize: native,
  'session-end': native,
  'subagent-stop': native,
  'user-message': { kind: 'skip', why: 'no host wires it; its banner is worker context' },
  'file-edit': native,
  'file-context': native,
  'post-compact': native,
  'subagent-context': native,
};
