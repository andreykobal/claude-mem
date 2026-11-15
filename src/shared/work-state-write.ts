import { z } from 'zod';
import type { WorkStateEntry, WorkStateFields } from '../services/sqlite/work-state.js';
import {
  fitWorkStateLines,
  renderWorkStateLines,
  WORK_STATE_SECTION_CHARACTER_LIMIT,
} from '../services/context/sections/WorkStateRenderer.js';
import { isMyRulesList } from '../services/work-view/my-rules.mjs';
import { isMyFocusList } from '../services/work-view/my-focus.mjs';
import { GOAL_KINDS, isOwnerGoalsList } from '../services/work-view/owner-goals.mjs';
import { MAX_WORK_STATE_FIELDS_JSON_CHARS } from '../services/work-view/work-state-limits.mjs';
import { isSharedWorkList } from '../services/work-view/shared-records.mjs';
import { isClosedWorkStateStatus } from '../services/work-view/work-state-status.mjs';

/**
 * One work_state_write, checked the same way wherever it is stored: the local
 * worker (WorkStateRoutes) and the server runtime (/v1/work-state/entries).
 */

export { MAX_WORK_STATE_FIELDS_JSON_CHARS };

// z.record intentionally drops __proto__; here every field is a primitive,
// so validate own entries and copy with spread to keep literal data keys safely.
// An integer past 2^53 cannot cross cloud sync's canonical JSON
// (CanonicalContent), so it is refused here instead of quarantined later.
export const workStateFieldsSchema = z.custom<WorkStateFields>(value =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, field]) => key.length > 0 && (
      field === null || typeof field === 'string' || typeof field === 'boolean'
      || (typeof field === 'number' && Number.isFinite(field) && (!Number.isInteger(field) || Number.isSafeInteger(field)))
    )),
  'fields must map non-empty keys to strings, safe finite numbers, booleans or null',
).transform(fields => ({ ...fields }));

export const workStateListSchema = z.string().trim().min(1).max(200)
  .refine(list => !isSharedWorkList(list), 'This list is reserved for shared My Work records');

export const workStateWriteFieldsSchema = workStateFieldsSchema
  .refine(fields => Object.keys(fields).length > 0, 'fields must set at least one key')
  .refine(
    fields => JSON.stringify(fields).length <= MAX_WORK_STATE_FIELDS_JSON_CHARS,
    `fields must be at most ${MAX_WORK_STATE_FIELDS_JSON_CHARS} characters as JSON`,
  );

/** Why an owner-goals row cannot be saved, or null. List state rows and a row that only closes an item need no kind. */
export function ownerGoalsRowRefusal(fields: WorkStateFields): string | null {
  if (fields.task == null || fields.task === '') return null;
  const onlyCloses = Object.keys(fields).every(key => key === 'task' || key === 'status') && isClosedWorkStateStatus(fields.status);
  if (onlyCloses && !('goal_kind' in fields)) return null;
  if (!(GOAL_KINDS as unknown[]).includes(fields.goal_kind)) {
    return `an owner-goals item needs goal_kind ${GOAL_KINDS.map(kind => `"${kind}"`).join(' or ')}; got ${JSON.stringify(fields.goal_kind ?? null)}.`;
  }
  return null;
}

export type WorkStateWriteRefusal = { status: 400 | 403; message: string };

/**
 * Why an agent's write to this list cannot be saved, or null. My Rules and My
 * Focus rows are written only from the viewer; an owner-goals item of a kind My
 * Work cannot read would stop the whole view, so it is refused at the door.
 */
export function workStateWriteRefusal(list: string, fields: WorkStateFields): WorkStateWriteRefusal | null {
  if (isMyRulesList(list)) {
    return { status: 403, message: `Not saved: "${list}" is written only from My Rules in the claude-mem viewer.` };
  }
  if (isMyFocusList(list)) {
    return { status: 403, message: `Not saved: "${list}" is written only from My Focus in the claude-mem viewer.` };
  }
  if (isOwnerGoalsList(list)) {
    const refusal = ownerGoalsRowRefusal(fields);
    if (refusal) return { status: 400, message: `Not saved: ${refusal}` };
  }
  return null;
}

/** The agent's answer to a saved write: only what is still open in the list, cut like the SessionStart section. */
export function workStateWriteReply(listEntries: WorkStateEntry[], list: string, project: string, nowEpoch: number): string {
  const openLines = renderWorkStateLines(listEntries, nowEpoch);
  const saved = `Saved to "${list}" in ${project}.`;
  return openLines.length > 0
    ? fitWorkStateLines(`${saved} Still open in it:`, openLines, WORK_STATE_SECTION_CHARACTER_LIMIT)
    : `${saved} Nothing in it is open now.`;
}

/** The agent's answer to work_state_read. */
export function workStateReadReply(
  entries: WorkStateEntry[],
  options: { list?: string; includeClosed: boolean; project: string; nowEpoch: number },
): string {
  const lines = renderWorkStateLines(entries, options.nowEpoch, options.includeClosed);
  if (lines.length > 0) return lines.join('\n');
  const inList = options.list ? ` in "${options.list}"` : '';
  return options.includeClosed
    ? `Nothing recorded${inList} for ${options.project}.`
    : `Nothing open${inList} for ${options.project}. Pass includeClosed to see closed items.`;
}
