// SPDX-License-Identifier: Apache-2.0

// Lets a client name its project instead of carrying a server project id.
//
// A hook knows its working directory, so it can compute the same project name
// the local runtime uses, but not the server's project UUID. When a request
// body carries `projectId: "name:<project>"`, this middleware (mounted after
// auth) replaces it with the id of the caller team's project of that name.
// Write routes create the project on first use; read routes only look it up,
// so an unknown name reads as an empty project rather than creating one.
//
// A project-scoped API key never creates projects: its name resolves only to
// an existing project, and the routes' own scope check still refuses any
// project other than the key's.

import type { RequestHandler } from 'express';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { getOrCreateProjectByName, PostgresProjectsRepository } from '../../storage/postgres/projects.js';
import { logger } from '../../utils/logger.js';

export const PROJECT_NAME_REF_PREFIX = 'name:';
/** Upper bound on a project name carried in a reference. */
export const PROJECT_NAME_REF_MAX_LENGTH = 200;

/** The project name inside a `name:<project>` reference, or null for anything else. */
export function parseProjectNameRef(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(PROJECT_NAME_REF_PREFIX)) return null;
  return value.slice(PROJECT_NAME_REF_PREFIX.length).trim();
}

/**
 * A read naming several projects (`projectIds`, e.g. a worktree and its
 * parent, or every project for CLAUDE_MEM_CONTEXT_PROJECTS=all): each
 * `name:<project>` becomes the team's project id; names with no project are
 * dropped, so they read as empty. Reads only: a list never creates projects.
 */
async function resolveProjectIdList(pool: PostgresPool, teamId: string, values: unknown[]): Promise<string[]> {
  const repo = new PostgresProjectsRepository(pool);
  const ids: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const name = parseProjectNameRef(value);
    if (name === null) { ids.push(value); continue; }
    if (!name || name.length > PROJECT_NAME_REF_MAX_LENGTH) continue;
    const project = await repo.getByNameForTeam(name, teamId);
    if (project) ids.push(project.id);
  }
  return [...new Set(ids)];
}

export function projectNameResolver(pool: PostgresPool, options: { create: boolean }): RequestHandler {
  return async (req, res, next) => {
    const body = req.body as { projectId?: unknown; projectIds?: unknown } | undefined;
    if (!options.create && Array.isArray(body?.projectIds) && req.authContext?.teamId) {
      try {
        (body as { projectIds: string[] }).projectIds = await resolveProjectIdList(pool, req.authContext.teamId, body!.projectIds as unknown[]);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('SYSTEM', 'project name list could not be resolved', { requestId: req.requestId ?? null }, err);
        res.status(503).json({ error: 'ServiceUnavailable', message: 'project names could not be resolved' });
        return;
      }
    }
    const name = parseProjectNameRef(body?.projectId);
    if (name === null) return next();
    if (!name || name.length > PROJECT_NAME_REF_MAX_LENGTH) {
      res.status(400).json({ error: 'BadRequest', message: `projectId name reference must be 1-${PROJECT_NAME_REF_MAX_LENGTH} characters` });
      return;
    }
    const teamId = req.authContext?.teamId;
    // No team (local-dev bypass): leave the body alone; the route answers.
    if (!teamId) return next();
    try {
      const project = options.create && !req.authContext?.projectId
        ? await getOrCreateProjectByName(pool, { teamId, name })
        : await new PostgresProjectsRepository(pool).getByNameForTeam(name, teamId);
      if (project) (req.body as { projectId: string }).projectId = project.id;
      next();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('SYSTEM', 'project name reference could not be resolved', { requestId: req.requestId ?? null }, err);
      res.status(503).json({ error: 'ServiceUnavailable', message: 'project name could not be resolved' });
    }
  };
}
