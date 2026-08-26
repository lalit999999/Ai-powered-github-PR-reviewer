import type { Request, Response } from "express";
import { requireSession } from "../lib/auth/session.js";
import { requireTenantAccess } from "../lib/auth/tenant-access.js";
import { parseOrThrow } from "../lib/validation.js";
import { projectIdParamSchema } from "../modules/projects/project.schema.js";
import {
  connectRepositoryBodySchema,
  repositoryIdParamSchema,
  triggerIndexBodySchema,
} from "../modules/repositories/repository.schema.js";
import * as repositoryService from "../modules/repositories/repository.service.js";

/**
 * The three repository routes (phase-02 §7). Every handler is the same four steps and
 * nothing else — **authenticate → resolve tenancy → validate → delegate** — then
 * returns the envelope. No business logic, no ownership check of its own, no raw input
 * parsing (plan.md §28, phase-02 §13).
 *
 * `requireTenantAccess` is the only authorization path used here, and there is
 * deliberately not one line in this file that reads `repository.projectId` or
 * `project.userId`. Rule A also holds: nothing here imports the GitHub client — the
 * service does that.
 */

/**
 * POST /api/projects/:projectId/repositories — **202**, not 201.
 *
 * 202 because the row is created but the work the connect *implies* — indexing — has
 * only been requested (§7: "202 — indexing queued, not run inline"). Phase 03 is what
 * makes that queue real; the status code is correct now so it does not have to change
 * then.
 *
 * Tenancy is resolved on the **project**, which is what the caller must own to connect
 * anything to it. The repository does not exist yet, so there is nothing else to check.
 */
export async function connectRepository(req: Request, res: Response): Promise<void> {
  const session = await requireSession(req);
  const { projectId } = parseOrThrow(projectIdParamSchema, req.params);
  const body = parseOrThrow(connectRepositoryBodySchema, req.body);

  const tenant = await requireTenantAccess(session, { projectId });
  const repository = await repositoryService.connectRepository(tenant, body);

  res.status(202).json({ repository });
}

/** GET /api/repositories/:repositoryId — `{ repository, indexJob: null }`; 404 for
 * missing, foreign, or under a soft-deleted project (see requireTenantAccess for why
 * all three are 404 and not the 403 §7 lists). */
export async function getRepository(req: Request, res: Response): Promise<void> {
  const session = await requireSession(req);
  const { repositoryId } = parseOrThrow(repositoryIdParamSchema, req.params);

  const tenant = await requireTenantAccess(session, { repositoryId });
  const detail = await repositoryService.getRepositoryDetail(tenant);

  res.status(200).json(detail);
}

/**
 * DELETE /api/repositories/:repositoryId — **202**, disconnect accepted.
 *
 * 202 rather than 204 for the same reason the project delete uses it: the cascading job
 * cancellation this implies is asynchronous, and is a no-op today only because Phase 03
 * has not introduced jobs to cancel yet (§7, §11).
 *
 * No `allowDeleted` here, unlike `DELETE /api/projects/:id`. Idempotency is achieved at
 * the *row* level instead — the repository row is never soft-deleted, only transitioned
 * to `DISCONNECTED`, so it keeps resolving and `markDisconnected` reports 0 rows
 * changed on a repeat call.
 */
export async function disconnectRepository(req: Request, res: Response): Promise<void> {
  const session = await requireSession(req);
  const { repositoryId } = parseOrThrow(repositoryIdParamSchema, req.params);

  const tenant = await requireTenantAccess(session, { repositoryId });
  await repositoryService.disconnectRepository(tenant);

  res.status(202).json({ repositoryId: tenant.repositoryId });
}

/**
 * GET /api/repositories/:repositoryId/index-status — phase-03 §7.
 *
 * Deliberately separate from `getRepository` so the client can poll cheaply (one
 * `IndexJob` row, not the full repository payload) — see `repositoryService.getIndexStatus`'s
 * own doc comment for why a repository with no job yet still returns a coherent body
 * rather than 404/null.
 */
export async function getIndexStatus(req: Request, res: Response): Promise<void> {
  const session = await requireSession(req);
  const { repositoryId } = parseOrThrow(repositoryIdParamSchema, req.params);

  const tenant = await requireTenantAccess(session, { repositoryId });
  const status = await repositoryService.getIndexStatus(tenant);

  res.status(200).json(status);
}

/**
 * POST /api/repositories/:repositoryId/index — phase-03 §7. **202**, matching every
 * other route in this file that starts background work: the job is requested, not run
 * inline.
 */
export async function triggerIndex(req: Request, res: Response): Promise<void> {
  const session = await requireSession(req);
  const { repositoryId } = parseOrThrow(repositoryIdParamSchema, req.params);
  const body = parseOrThrow(triggerIndexBodySchema, req.body);

  const tenant = await requireTenantAccess(session, { repositoryId });
  const { indexJobId } = await repositoryService.triggerIndex(tenant, body);

  res.status(202).json({ indexJobId });
}

/**
 * POST /api/repositories/:repositoryId/webhook-test — phase-06 §7. **Reads, does not
 * send.** The name is §7's own and is misleading on its face — this returns the
 * repository's recent `WebhookEvent` deliveries; it does not dispatch a synthetic
 * webhook. §7 specifies `POST`, so this is `POST` — no `GET` alias is added (see the
 * phase report for the reasoning: this endpoint has no side effects, so `GET` would be
 * the more honest verb, but the spec is explicit and a second route for one read is not
 * worth the divergence).
 */
export async function getRecentWebhookDeliveries(req: Request, res: Response): Promise<void> {
  const session = await requireSession(req);
  const { repositoryId } = parseOrThrow(repositoryIdParamSchema, req.params);

  const tenant = await requireTenantAccess(session, { repositoryId });
  const recentDeliveries = await repositoryService.listRecentWebhookDeliveries(tenant);

  res.status(200).json({ recentDeliveries });
}
