// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand, logged, and answered with a no-op (never exit 2).
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { spoolHookEvent } from '../spool-hook-event.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';
import { recordServerMetadataEvent } from './server-metadata-event.js';

// Claude Code gives plugin SessionEnd hooks a 1.5-second budget, so this hook
// only spools the request and pokes the worker; it never waits on the worker.
// In server runtime it makes one request bounded well inside that budget.
const SESSION_END_SERVER_TIMEOUT_MS = 1_000;

export const sessionEndHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId } = input;

    if (!sessionId) {
      logger.warn('HOOK', 'session-end: No sessionId provided, skipping');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Session-init never registers an untracked session (observer, plugin cache,
    // excluded project), so its SessionEnd would sit in the spool until it expired.
    if (!shouldTrackProject(input.cwd ?? '')) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const platformSource = normalizePlatformSource(input.platform);
    const runtime = resolveRuntimeContext(input.cwd);
    if (runtime.runtime === 'server') {
      // Recorded only. Not /v1/sessions/:id/end: that starts the summary
      // generation, which Stop already asked for (or deliberately skipped).
      await recordServerMetadataEvent(runtime, {
        sessionId,
        platformSource,
        eventType: 'session_end',
        payload: { ...(input.cwd ? { cwd: input.cwd } : {}) },
      }, SESSION_END_SERVER_TIMEOUT_MS);
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Keyed on (session, platform) only — the worker uses nothing else — so a
    // SessionEnd re-delivered with another reason still overwrites one entry.
    spoolHookEvent('session_end', { contentSessionId: sessionId, platformSource });

    logger.debug('HOOK', 'Session-end request spooled, exiting hook');
    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  },
};
