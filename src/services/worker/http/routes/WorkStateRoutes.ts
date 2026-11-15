import express, { Request, Response } from 'express';
import { z } from 'zod';
import { DatabaseManager } from '../../DatabaseManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { isProjectExcluded } from '../../../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { getProjectContext } from '../../../../utils/project-name.js';
import { logger } from '../../../../utils/logger.js';
import {
  MAX_WORK_STATE_FIELDS_JSON_CHARS,
  ownerGoalsRowRefusal,
  workStateListSchema,
  workStateWriteFieldsSchema,
  workStateReadReply,
  workStateWriteRefusal,
  workStateWriteReply,
} from '../../../../shared/work-state-write.js';
import { isForeignBrowserRead, isForeignLoopbackBrowserWrite } from './SettingsRoutes.js';

export { MAX_WORK_STATE_FIELDS_JSON_CHARS, ownerGoalsRowRefusal };

const workStateWriteSchema = z.object({
  cwd: z.string().refine(cwd => cwd.trim().length > 0, 'cwd is required'),
  list: workStateListSchema,
  fields: workStateWriteFieldsSchema,
});

/**
 * Surface for `work_state_entries`, the agent's canonical to-do lists and
 * working state, called by the work_state_write / work_state_read MCP tools with
 * the session's cwd. A write lands under the checkout's primary project key; a
 * read covers every key the checkout reads (worktree parent included), the same
 * scope SessionStart shows. Both answer in plain text for the agent.
 */
export class WorkStateRoutes extends BaseRouteHandler {
  constructor(private dbManager: DatabaseManager) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/work-state/entries', validateBody(workStateWriteSchema), this.handleWrite.bind(this));
    app.get('/api/work-state', this.handleRead());
    app.get('/api/work-state/export', this.handleRead(true));
  }

  private handleWrite = this.wrapHandler((req: Request, res: Response): void => {
    // These rows are the agent's canonical to-do lists, so other localhost pages
    // may not write them. Origin-less callers (the work_state_write MCP tool,
    // save_goals.py) keep the existing loopback-trust model.
    if (isForeignLoopbackBrowserWrite(req)) {
      res.status(403).json({ error: 'Work-state writes from a different localhost origin are not allowed' });
      return;
    }
    const { cwd, list, fields } = req.body as z.infer<typeof workStateWriteSchema>;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
      logger.debug('WORKER', 'Work state write skipped for an excluded project', { cwd, list });
      res.send('Not saved: this project is excluded from claude-mem (CLAUDE_MEM_EXCLUDED_PROJECTS).');
      return;
    }

    // My Rules and My Focus rows are written only by the origin-checked
    // /api/work-view handlers; owner-goals items must name a kind My Work reads.
    const refusal = workStateWriteRefusal(list, fields);
    if (refusal) { res.status(refusal.status).send(refusal.message); return; }

    const checkout = getProjectContext(cwd);
    const store = this.dbManager.getSessionStore();
    store.appendWorkStateEntry({ project: checkout.primary, listName: list, fields });
    logger.debug('WORKER', 'Work state entry saved', { project: checkout.primary, list });
    // The row is a `work_state` sync op: nudge the push drain (null when sync is off).
    this.dbManager.getCloudSync()?.notify();
    // Only what is still open, so a long-kept list does not repeat its closed items on every write.
    res.send(workStateWriteReply(store.getWorkStateEntries(checkout.allProjects, list), list, checkout.primary, Date.now()));
  });

  private handleRead = (exportHistory = false) => this.wrapHandler((req: Request, res: Response): void => {
    // The read still resolves the project from `cwd`, and that resolution runs
    // `git` in it (findGitRepoRoot), so another browser page must not choose
    // the directory, even with a no-cors fetch that sends no Origin. Hooks, the
    // CLI and the MCP tool send no browser headers and keep working.
    if (isForeignBrowserRead(req)) {
      res.status(403).json({ error: 'Forbidden', message: 'Work-state reads from another browser page are not allowed' });
      return;
    }
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
    if (!cwd.trim()) {
      this.badRequest(res, 'cwd is required');
      return;
    }
    const list = typeof req.query.list === 'string' && req.query.list.trim() ? req.query.list.trim() : undefined;
    const includeClosed = req.query.includeClosed === 'true';

    const checkout = getProjectContext(cwd);
    const entries = this.dbManager.getSessionStore().getWorkStateEntries(checkout.allProjects, list);
    // Export the ordered patches, including closures and cleared fields, rather
    // than the presentation text that an MCP client may have to shorten.
    if (exportHistory) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', 'attachment; filename="work-state.json"');
      res.json({ version: 1, project: checkout.primary, projects: checkout.allProjects, list: list ?? null, entries });
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(workStateReadReply(entries, { list, includeClosed, project: checkout.primary, nowEpoch: Date.now() }));
  });
}
