/**
 * CLAUDE_MEM_WORKER_AUTOSTART=false means the worker is managed externally (a
 * process manager, a container, `worker-service.cjs --daemon`). Hooks, the MCP
 * server and `start` then use a worker that is already running but never
 * launch, kill or recycle one. Any value other than "false" keeps the default.
 *
 * A non-empty CLAUDE_MEM_WORKER_URL means the same thing, even when the value is
 * invalid: the worker lives at that URL, and a local worker sharing this data
 * directory would drain the outbox the uploader is meant to send there.
 *
 * Pure so every caller can pass its own settings source (the hooks' cached
 * read, or a fresh read of settings.json in long-lived processes).
 */
export function isWorkerAutostartDisabled(settings: { CLAUDE_MEM_WORKER_AUTOSTART?: string; CLAUDE_MEM_WORKER_URL?: string }): boolean {
  if (settings.CLAUDE_MEM_WORKER_URL?.trim()) return true;
  return (settings.CLAUDE_MEM_WORKER_AUTOSTART ?? 'true').trim().toLowerCase() === 'false';
}

type LaunchSettings = {
  CLAUDE_MEM_WORKER_AUTOSTART?: string;
  CLAUDE_MEM_WORKER_URL?: string;
  CLAUDE_MEM_RUNTIME?: string;
  CLAUDE_MEM_SERVER_URL?: string;
  CLAUDE_MEM_SERVER_BETA_URL?: string;
  CLAUDE_MEM_SERVER_API_KEY?: string;
  CLAUDE_MEM_SERVER_BETA_API_KEY?: string;
};

/**
 * CLAUDE_MEM_RUNTIME=server with the server's URL and key set: every hook and
 * MCP tool talks to that server, the same test resolveRuntimeContext() makes.
 * Incomplete server settings resolve to the worker runtime there, so they do
 * here too.
 */
export function isServerRuntimeConfigured(settings: LaunchSettings): boolean {
  const runtime = (settings.CLAUDE_MEM_RUNTIME ?? '').trim().toLowerCase();
  if (runtime !== 'server' && runtime !== 'server-beta') return false;
  const url = (settings.CLAUDE_MEM_SERVER_URL ?? '').trim() || (settings.CLAUDE_MEM_SERVER_BETA_URL ?? '').trim();
  const key = (settings.CLAUDE_MEM_SERVER_API_KEY ?? '').trim() || (settings.CLAUDE_MEM_SERVER_BETA_API_KEY ?? '').trim();
  return url.length > 0 && key.length > 0;
}

/**
 * Whether hooks and the MCP server must not launch, kill or recycle a local
 * worker: it is managed externally, or the server runtime is in use. In server
 * runtime nothing reads the local store, and a worker started by a slow server
 * reply would run its scheduled agents and capture on the user's plan into a
 * database no session reads.
 */
export function isLocalWorkerLaunchDisabled(settings: LaunchSettings): boolean {
  return isWorkerAutostartDisabled(settings) || isServerRuntimeConfigured(settings);
}
