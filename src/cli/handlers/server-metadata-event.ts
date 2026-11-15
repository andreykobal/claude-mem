import type { ServerRuntimeContext } from '../../services/hooks/runtime-selector.js';
import { logServerFallback, resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';
import type { NormalizedHookInput } from '../types.js';
import type { SpooledDeliverablesPayload } from '../../shared/hook-spool.js';
import { isServerClientError } from '../../services/hooks/server-client.js';
import { logger } from '../../utils/logger.js';

/**
 * Record a session metadata event (session end, subagent stop, deliverables)
 * on the server in server runtime. `generate=false`: the event is stored and
 * never starts inference, as the lifecycle contract asks of metadata. One
 * bounded request; a failure is logged and the event is skipped.
 */
export async function recordServerMetadataEvent(
  runtime: ServerRuntimeContext,
  event: { sessionId: string; platformSource: string; eventType: string; payload: Record<string, unknown> },
  timeoutMs: number,
): Promise<void> {
  try {
    await runtime.client.recordEvent({
      projectId: runtime.projectId,
      contentSessionId: event.sessionId,
      platformSource: event.platformSource,
      sourceType: 'hook',
      eventType: event.eventType,
      occurredAtEpoch: Date.now(),
      payload: event.payload,
      generate: false,
    }, { timeoutMs });
  } catch (error) {
    if (isServerClientError(error)) {
      logServerFallback(error.kind, { status: error.status, message: error.message, route: '/v1/events', eventType: event.eventType });
      return;
    }
    logger.warn('HOOK', 'Server metadata event failed', {
      eventType: event.eventType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const DELIVERABLES_SERVER_TIMEOUT_MS = 3_000;

/**
 * The record of this turn's deliverables in server runtime: which files were
 * copied into this machine's bucket, with their hashes. The files stay on this
 * machine; only the record goes to the server.
 */
export async function recordServerDeliverables(
  input: NormalizedHookInput,
  payload: SpooledDeliverablesPayload,
): Promise<void> {
  const runtime = resolveRuntimeContext(input.cwd);
  if (runtime.runtime !== 'server') return;
  await recordServerMetadataEvent(runtime, {
    sessionId: payload.contentSessionId,
    platformSource: payload.platformSource,
    eventType: 'deliverables',
    payload: { ...payload },
  }, DELIVERABLES_SERVER_TIMEOUT_MS);
}
