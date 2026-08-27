import type { Request, Response } from "express";
import { requireSession } from "../lib/auth/session.js";
import { requireTenantAccess } from "../lib/auth/tenant-access.js";
import { parseOrThrow } from "../lib/validation.js";
import {
  createProjectBodySchema,
  listProjectsQuerySchema,
  projectIdParamSchema,
} from "../modules/projects/project.schema.js";
import * as projectService from "../modules/projects/project.service.js";

/**
 * The four project routes (phase-01 §7). Every handler is the same four steps and
 * nothing else — **authenticate → resolve tenancy → validate → delegate** — then
 * returns the envelope. No business logic, no ownership check of its own, no raw input
 * parsing (plan.md §28, phase-01 §13).
 *
 * `requireTenantAccess` is the only authorization path used here. There is deliberately
 * not one line in this file that reads `project.userId`.
 */

/** GET /api/projects — 401 without a session; returns only the caller's own
 * non-deleted projects. */
export async function listProjects(req: Request, res: Response): Promise<void> {
  const session = await requireSession(req);
  const query = parseOrThrow(listProjectsQuerySchema, req.query);

  const page = await projectService.listProjects(
    { userId: session.user.id },
    query,
  );

  res.status(200).json(page);
}

/** POST /api/projects — 400 invalid name, 409 slug taken, 401 no session. */
export async function createProject(
  req: Request,
  res: Response,
): Promise<void> {
  const session = await requireSession(req);
  const body = parseOrThrow(createProjectBodySchema, req.body);

  const project = await projectService.createProject(
    { userId: session.user.id },
    body,
  );

  res.status(201).json({ project });
}

/** GET /api/projects/:projectId — `{ project, repositories: [] }`; 404 for missing,
 * soft-deleted, or foreign (see requireTenantAccess for why all three are 404). */
export async function getProject(req: Request, res: Response): Promise<void> {
  const session = await requireSession(req);
  const { projectId } = parseOrThrow(projectIdParamSchema, req.params);

  const tenant = await requireTenantAccess(session, { projectId });
  const detail = await projectService.getProjectDetail(tenant);

  res.status(200).json(detail);
}

/**
 * DELETE /api/projects/:projectId — 202, soft-delete accepted.
 *
 * `allowDeleted` is what makes this idempotent (phase-01 §4 Reliability): the tenancy
 * check still rejects a foreign or nonexistent project with 404, but a project this
 * caller already deleted resolves, and the service's soft-delete is a no-op. 202 rather
 * than 204 because the cascading cancellation this event will eventually trigger is
 * asynchronous — it is a no-op today only because there are no jobs to cancel yet
 * (§7, §8).
 */
export async function deleteProject(
  req: Request,
  res: Response,
): Promise<void> {
  const session = await requireSession(req);
  const { projectId } = parseOrThrow(projectIdParamSchema, req.params);

  const tenant = await requireTenantAccess(
    session,
    { projectId },
    { allowDeleted: true },
  );
  await projectService.softDeleteProject(tenant);

  res.status(202).json({ projectId: tenant.projectId });
}
