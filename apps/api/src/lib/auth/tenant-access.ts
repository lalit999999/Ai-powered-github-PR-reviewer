import * as projectRepository from "../../modules/projects/project.repository.js";
import { InternalError, NotFoundError } from "../errors.js";
import { createLogger } from "../logger.js";
import { setTraceProjectId } from "../tracing.js";
import type { AuthenticatedSession } from "./session.js";

const logger = createLogger("auth.tenant-access");

/**
 * The owner half of a tenant context — everything that is known before a specific
 * resource has been resolved. `POST`/`GET /api/projects` operate on the collection, so
 * there is no `projectId` yet; they take this. Every `TenantContext` is assignable to
 * it, so a service that only needs the owner can be called from either path.
 */
export interface OwnerContext {
  userId: string;
}

/**
 * Produced by {@link requireTenantAccess} and consumed by every service call that
 * touches a specific project (plan.md §5/§34.2). Phase 02 adds an optional
 * `repositoryId`; the shape only ever grows.
 */
export interface TenantContext extends OwnerContext {
  projectId: string;
}

/**
 * What the caller is asking to reach. Deliberately a bag of optional ids rather than a
 * positional argument: Phase 02 adds `repositoryId?`, Phase 07 `reviewId?`, and each
 * one resolves *up* the ownership chain to the same `TenantContext`. Every later
 * phase extends this helper — it is never reimplemented per resource type
 * (phase-01 §7, plan.md §34.2).
 */
export interface TenantResource {
  projectId?: string;
}

export interface TenantAccessOptions {
  /**
   * Let a soft-deleted project resolve instead of rendering as not-found.
   *
   * Exactly one caller sets this: `DELETE /api/projects/:id`. Phase-01 §4 requires the
   * delete to be idempotent ("deleting an already-deleted project returns success, not
   * an error"), which is impossible if the tenancy check 404s on the second call.
   * Ownership is still enforced — a *foreign* soft-deleted project is still 404 — and
   * every read path leaves this off, so a soft-deleted project stays invisible
   * everywhere else (§7, §11).
   */
  allowDeleted?: boolean;
}

/**
 * Why a check failed. Never reaches the caller — see the 404 note on
 * {@link requireTenantAccess} — but is recorded on the warn line so a real
 * authorization bug (`FOREIGN` spikes) is distinguishable from a client holding a
 * stale id (`MISSING`/`DELETED`).
 */
type DenialReason = "MISSING" | "FOREIGN" | "DELETED";

/**
 * **The single authorization chokepoint.** No route handler resolves ownership itself
 * — not now, and not in any later phase (phase-01 §13, plan.md §34.2). Handlers
 * authenticate, call this, and hand the resulting `TenantContext` to a service.
 *
 * ## Why every failure is a 404
 *
 * Phase-01 §7 lists `403 not owner` and `404 not found` as separate outcomes, while
 * §12 says a 403 that reveals a resource *exists* but isn't yours is itself an
 * information leak, and that both cases render as 404. Those two statements are in
 * tension, and this is where the tension is resolved, once, for the whole system:
 *
 * > **Missing, soft-deleted, and foreign projects all return 404 to the caller.** The
 * > distinction survives only in the log line.
 *
 * §12 wins because it is the stronger security property: a 403 is an oracle that turns
 * "guess an id" into "enumerate other tenants' resources". `ForbiddenError` stays in
 * the error hierarchy (src/lib/errors.ts) — later phases have resource types where the
 * caller already provably knows the resource exists (e.g. a repository they connected
 * that has since been reassigned), and 403 is the honest answer there.
 *
 * Reads through `project.repository`, never raw Prisma (Rule B / phase-00 §3).
 *
 * @throws NotFoundError (404) if the project is missing, soft-deleted, or owned by
 *         someone else.
 * @throws InternalError (500) if `resource` names nothing resolvable — a programming
 *         error in the caller, not a client condition.
 */
export async function requireTenantAccess(
  session: AuthenticatedSession,
  resource: TenantResource,
  options: TenantAccessOptions = {}
): Promise<TenantContext> {
  const userId = session.user.id;

  if (!resource.projectId) {
    // Unreachable from a correctly written handler: v1 can only resolve a projectId,
    // so an empty resource means the call site forgot to pass one. Surfacing it as a
    // 500 (rather than silently returning a context with no tenant) keeps "a
    // TenantContext always names a real, owned project" true by construction.
    throw new InternalError("requireTenantAccess called without a resolvable resource");
  }

  const projectId = resource.projectId;
  const project = await projectRepository.findOwnershipById(projectId);

  if (!project) {
    throw denied(projectId, userId, "MISSING");
  }
  if (project.userId !== userId) {
    throw denied(projectId, userId, "FOREIGN");
  }
  if (project.deletedAt !== null && !options.allowDeleted) {
    throw denied(projectId, userId, "DELETED");
  }

  // phase-01 §16/§20: from here on, every log line in this request carries projectId
  // alongside the userId that requireSession already put in the trace context —
  // including the request-completion line emitted after the handler returns.
  setTraceProjectId(projectId);

  return { userId, projectId };
}

/**
 * The logging convention every later phase's tenancy check follows (phase-01 §20):
 * `warn`, with the attempted `projectId`, the requesting `userId`, and the internal
 * reason. This is the first signal of an authorization bug or a probing attempt, so it
 * is deliberately noisier than the 404 the caller sees.
 */
function denied(projectId: string, userId: string, reason: DenialReason): NotFoundError {
  logger.warn("tenant access denied", { projectId, userId, reason });
  return new NotFoundError("Project not found");
}
