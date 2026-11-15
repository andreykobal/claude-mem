import type { ServerRuntimeContext } from '../hooks/runtime-selector.js';
import type { ServerWorkStateEntry } from '../hooks/server-client.js';
import type { WorkStateEntry } from '../sqlite/work-state.js';
import { buildWorkStateContextSection } from './sections/WorkStateRenderer.js';
import { logger } from '../../utils/logger.js';

/**
 * Work state in server runtime: the server stores the ordered writes
 * (/v1/work-state), and they are folded and rendered here with the same
 * WorkStateRenderer the local store feeds, so both runtimes read alike.
 */

/** Server rows in the local store's shape, labeled with the checkout's project name. */
export function toWorkStateEntries(entries: ServerWorkStateEntry[], project: string): WorkStateEntry[] {
  return entries.map(entry => ({
    id: entry.id,
    project,
    list_name: entry.list,
    fields: entry.fields,
    created_at_epoch: entry.createdAtEpoch,
  }));
}

/**
 * The SessionStart work-state section from the server, or '' when nothing is
 * open. A server that cannot answer gives '' too: the section is left out, and
 * no local rows are read in its place.
 */
export async function readServerWorkStateSection(
  runtime: ServerRuntimeContext,
  project: string,
  timeoutMs?: number,
): Promise<string> {
  try {
    const { entries } = await runtime.client.readWorkStateEntries(
      { projectId: runtime.projectId },
      timeoutMs === undefined ? {} : { timeoutMs },
    );
    return buildWorkStateContextSection(toWorkStateEntries(entries ?? [], project), Date.now());
  } catch (error) {
    logger.warn('HOOK', '[server-fallback] reason=work_state_read_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}
