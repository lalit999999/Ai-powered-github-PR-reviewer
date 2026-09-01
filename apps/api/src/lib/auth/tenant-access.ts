import * as projectRepository from "../../modules/projects/project.repository.js";
import * as pullRequestRepository from "../../modules/pull-requests/pull-request.repository.js";
import * as repositoryRepository from "../../modules/repositories/repository.repository.js";
import * as reviewRepository from "../../modules/reviews/review.repository.js";
import { InternalError, NotFoundError } from "../errors.js";
import {
  createLogger,
  setTraceProjectId,
  setTraceRepositoryId,
} from "@repo/observability";
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
 * touches a specific project (plan.md §5/§34.2). The shape only ever grows.
 *
 * `projectId` is always present — every resource in this system resolves *up* the
 * ownership chain to the project that owns it, so every context names it. `repositoryId`,
 * `pullRequestId`, and `reviewId` are present only as far up the chain as the caller
 * actually asked to resolve: a `reviewId` context (Phase 07 sub-task 1.5) resolves the
 * *whole* chain in one query and so names all four — `projectId`, `repositoryId`,
 * `pullRequestId`, and `reviewId` — because later services on that path legitimately
 * need all four and should not re-query for them; a bare `repositoryId` context still
 * names only `projectId`/`repositoryId`, exactly as it did before this extension.
 */
export interface TenantContext extends OwnerContext {
  projectId: string;
  repositoryId?: string;
  pullRequestId?: string;
  reviewId?: string;
}

/**
 * What the caller is asking to reach. Deliberately a bag of optional ids rather than a
 * positional argument: Phase 02 added `repositoryId?`, Phase 07 sub-task 1.5 adds
 * `pullRequestId?` and `reviewId?`, and each one resolves *up* the ownership chain to
 * the same `TenantContext`. Every later phase extends this helper — it is never
 * reimplemented per resource type (phase-01 §7, phase-02 §7, plan.md §34.2).
 */
export interface TenantResource {
  projectId?: string;
  repositoryId?: string;
  pullRequestId?: string;
  reviewId?: string;
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
   *
   * Note that `DELETE /api/repositories/:id` does **not** need this: disconnecting is
   * idempotent at the *row* level (`markDisconnected` reports 0 rows changed), and the
   * repository row itself is never soft-deleted. This flag only ever concerns the
   * parent project.
   */
  allowDeleted?: boolean;
}

/**
 * Why a check failed. Never reaches the caller — see the 404 note on
 * {@link requireTenantAccess} — but is recorded on the warn line so a real
 * authorization bug (`FOREIGN` spikes) is distinguishable from a client holding a
 * stale id (`MISSING`/`DELETED`).
 *
 * `MISMATCH` is Phase 02's addition: the caller named both a `projectId` and a
 * `repositoryId`, and the repository does not belong to that project.
 */
type DenialReason = "MISSING" | "FOREIGN" | "DELETED" | "MISMATCH";

/**
 * **The single authorization chokepoint.** No route handler resolves ownership itself
 * — not now, and not in any later phase (phase-01 §13, plan.md §34.2). Handlers
 * authenticate, call this, and hand the resulting `TenantContext` to a service.
 *
 * ## Why every tenancy failure is a 404
 *
 * Phase-01 §7 lists `403 not owner` and `404 not found` as separate outcomes, while
 * §12 says a 403 that reveals a resource *exists* but isn't yours is itself an
 * information leak, and that both cases render as 404. Those two statements are in
 * tension, and this is where the tension is resolved, once, for the whole system:
 *
 * > **Missing, foreign, mismatched, and soft-deleted-parent resources all return 404
 * > to the caller.** The distinction survives only in the log line.
 *
 * §12 wins because it is the stronger security property: a 403 is an oracle that turns
 * "guess an id" into "enumerate other tenants' resources".
 *
 * ## Phase 02 re-opened this, and the answer did not change
 *
 * phase-02 §7 lists `403` as a possible error for `GET`/`DELETE /api/repositories/:id`.
 * That is **not** followed for tenancy, for the reason above — a repository id is an
 * opaque uuid, exactly the kind of value a 403 would let an attacker enumerate.
 * phase-01-log §16 settled this deliberately and phase-02-log records the re-decision.
 *
 * What §7's 403 *is* right about is a different case, and `ForbiddenError` is reserved
 * for it: the caller **provably owns the project** and is being told that the *GitHub
 * App* cannot reach the repository they named (phase-02 §12 — "the GitHub App doesn't
 * have access to this repository — check your installation settings"). That is not an
 * information leak; the user already knows the repository exists, because they just
 * typed its URL, and the 403 is the only actionable answer. It is raised by
 * `repository-validation.service`, never here.
 *
 * One more deliberate 403 exists, in `github.controller.ts`, for an installation the
 * caller does not own — see that file for why an installation id is not an oracle the
 * way a project id is.
 *
 * Reads through the module repository layers, never raw Prisma (Rule B / phase-00 §3).
 *
 * @throws NotFoundError (404) if the resource is missing, foreign, mismatched, or its
 *         parent project is soft-deleted.
 * @throws InternalError (500) if `resource` names nothing resolvable — a programming
 *         error in the caller, not a client condition.
 */
export async function requireTenantAccess(
  session: AuthenticatedSession,
  resource: TenantResource,
  options: TenantAccessOptions = {},
): Promise<TenantContext> {
  const userId = session.user.id;

  // Most specific first — a `reviewId` resolves the whole chain in one query, so it is
  // checked before a bare `pullRequestId`/`repositoryId` would otherwise be reached.
  if (resource.reviewId) {
    return resolveReview(userId, resource.reviewId, resource, options);
  }

  if (resource.pullRequestId) {
    return resolvePullRequest(userId, resource.pullRequestId, resource, options);
  }

  if (resource.repositoryId) {
    return resolveRepository(
      userId,
      resource.repositoryId,
      resource.projectId,
      options,
    );
  }

  if (!resource.projectId) {
    // Unreachable from a correctly written handler: an empty resource means the call
    // site forgot to pass an id. Surfacing it as a 500 (rather than silently returning
    // a context with no tenant) keeps "a TenantContext always names a real, owned
    // project" true by construction — a guarantee that has to survive every extension
    // of this function, including this one.
    throw new InternalError(
      "requireTenantAccess called without a resolvable resource",
    );
  }

  const projectId = resource.projectId;
  const project = await projectRepository.findOwnershipById(projectId);

  if (!project) {
    throw denied({ projectId, userId, reason: "MISSING" });
  }
  if (project.userId !== userId) {
    throw denied({ projectId, userId, reason: "FOREIGN" });
  }
  if (project.deletedAt !== null && !options.allowDeleted) {
    throw denied({ projectId, userId, reason: "DELETED" });
  }

  // phase-01 §16/§20: from here on, every log line in this request carries projectId
  // alongside the userId that requireSession already put in the trace context —
  // including the request-completion line emitted after the handler returns.
  setTraceProjectId(projectId);

  return { userId, projectId };
}

/**
 * The `repositoryId` extension (phase-02 §7). Resolves `Repository → Project → userId`
 * in **one query** (see `repository.repository.findOwnershipById`) and returns a
 * context carrying **both** ids, because every repository is under exactly one project
 * and services on this path legitimately need the parent.
 *
 * When the caller supplies both ids, the repository is resolved first and its
 * `projectId` is then asserted against the one that was named. A mismatch is a
 * **denial, not a silent preference for one** — quietly trusting the repository's own
 * projectId would let `POST /api/projects/{a}/…/{repo-under-b}`-shaped call sites
 * operate on the wrong project without anyone noticing.
 */
async function resolveRepository(
  userId: string,
  repositoryId: string,
  expectedProjectId: string | undefined,
  options: TenantAccessOptions,
): Promise<TenantContext> {
  const repository = await repositoryRepository.findOwnershipById(repositoryId);

  if (!repository) {
    throw denied({
      repositoryId,
      projectId: expectedProjectId ?? null,
      userId,
      reason: "MISSING",
    });
  }
  if (repository.userId !== userId) {
    throw denied({
      repositoryId,
      projectId: repository.projectId,
      userId,
      reason: "FOREIGN",
    });
  }
  if (
    expectedProjectId !== undefined &&
    repository.projectId !== expectedProjectId
  ) {
    // Logged with the *attempted* project, not the real one — the real one is not the
    // caller's business and the attempted one is what a probing pattern looks like.
    throw denied({
      repositoryId,
      projectId: expectedProjectId,
      userId,
      reason: "MISMATCH",
    });
  }
  if (repository.projectDeletedAt !== null && !options.allowDeleted) {
    // A repository under a soft-deleted project is not reachable, for the same reason
    // the project itself is not: phase-01 §7/§11.
    throw denied({
      repositoryId,
      projectId: repository.projectId,
      userId,
      reason: "DELETED",
    });
  }

  setTraceProjectId(repository.projectId);
  // phase-02 §20: the completion line must name the repository too.
  setTraceRepositoryId(repositoryId);

  return { userId, projectId: repository.projectId, repositoryId };
}

/**
 * The `pullRequestId` extension (Phase 07 sub-task 1.5). Resolves
 * `PullRequest → Repository → Project → userId` in **one query**
 * (`pull-request.repository.findOwnershipById`) and returns a context carrying
 * `projectId`, `repositoryId`, and `pullRequestId` — every pull request is under
 * exactly one repository under exactly one project, and services on this path
 * legitimately need both parents.
 *
 * When the caller also supplies `projectId` and/or `repositoryId`, each is asserted
 * against the resolved chain — the identical "a mismatch is a denial, not a silent
 * preference for one" rule `resolveRepository` above already enforces, extended to a
 * second possible mismatch point now that there are two ancestors to check instead of
 * one.
 */
async function resolvePullRequest(
  userId: string,
  pullRequestId: string,
  resource: TenantResource,
  options: TenantAccessOptions,
): Promise<TenantContext> {
  const pullRequest =
    await pullRequestRepository.findOwnershipById(pullRequestId);

  if (!pullRequest) {
    throw denied({
      pullRequestId,
      projectId: resource.projectId ?? null,
      userId,
      reason: "MISSING",
    });
  }
  if (pullRequest.userId !== userId) {
    throw denied({
      pullRequestId,
      projectId: pullRequest.projectId,
      userId,
      reason: "FOREIGN",
    });
  }
  if (
    (resource.projectId !== undefined &&
      pullRequest.projectId !== resource.projectId) ||
    (resource.repositoryId !== undefined &&
      pullRequest.repositoryId !== resource.repositoryId)
  ) {
    // Logged with the *attempted* ids, not the real ones — same reasoning
    // resolveRepository's own MISMATCH branch already argues.
    throw denied({
      pullRequestId,
      projectId: resource.projectId ?? pullRequest.projectId,
      userId,
      reason: "MISMATCH",
      repositoryId: resource.repositoryId,
    });
  }
  if (pullRequest.projectDeletedAt !== null && !options.allowDeleted) {
    throw denied({
      pullRequestId,
      projectId: pullRequest.projectId,
      userId,
      reason: "DELETED",
      repositoryId: pullRequest.repositoryId,
    });
  }

  setTraceProjectId(pullRequest.projectId);
  setTraceRepositoryId(pullRequest.repositoryId);

  return {
    userId,
    projectId: pullRequest.projectId,
    repositoryId: pullRequest.repositoryId,
    pullRequestId,
  };
}

/**
 * The `reviewId` extension (Phase 07 sub-task 1.5). Resolves
 * `Review → PullRequest → Repository → Project → userId` in **one query**
 * (`review.repository.findOwnershipById`) and returns a context carrying all four ids —
 * a review resolves the entire chain, and later services on this path legitimately need
 * `projectId`, `repositoryId`, and `pullRequestId` alongside `reviewId` without
 * re-querying for them.
 *
 * Mismatch checking extends one hop further than `resolvePullRequest`'s: a caller may
 * supply any combination of `projectId`, `repositoryId`, and `pullRequestId` alongside
 * `reviewId`, and each supplied id is asserted against the resolved chain.
 */
async function resolveReview(
  userId: string,
  reviewId: string,
  resource: TenantResource,
  options: TenantAccessOptions,
): Promise<TenantContext> {
  const review = await reviewRepository.findOwnershipById(reviewId);

  if (!review) {
    throw denied({
      reviewId,
      projectId: resource.projectId ?? null,
      userId,
      reason: "MISSING",
    });
  }
  if (review.userId !== userId) {
    throw denied({
      reviewId,
      projectId: review.projectId,
      userId,
      reason: "FOREIGN",
    });
  }
  if (
    (resource.projectId !== undefined &&
      review.projectId !== resource.projectId) ||
    (resource.repositoryId !== undefined &&
      review.repositoryId !== resource.repositoryId) ||
    (resource.pullRequestId !== undefined &&
      review.pullRequestId !== resource.pullRequestId)
  ) {
    throw denied({
      reviewId,
      projectId: resource.projectId ?? review.projectId,
      userId,
      reason: "MISMATCH",
      repositoryId: resource.repositoryId,
      pullRequestId: resource.pullRequestId,
    });
  }
  if (review.projectDeletedAt !== null && !options.allowDeleted) {
    throw denied({
      reviewId,
      projectId: review.projectId,
      userId,
      reason: "DELETED",
      repositoryId: review.repositoryId,
      pullRequestId: review.pullRequestId,
    });
  }

  setTraceProjectId(review.projectId);
  setTraceRepositoryId(review.repositoryId);

  return {
    userId,
    projectId: review.projectId,
    repositoryId: review.repositoryId,
    pullRequestId: review.pullRequestId,
    reviewId,
  };
}

interface Denial {
  projectId: string | null;
  userId: string;
  reason: DenialReason;
  repositoryId?: string;
  pullRequestId?: string;
  reviewId?: string;
}

/**
 * The logging convention every later phase's tenancy check follows (phase-01 §20,
 * phase-02 §20): `warn`, with the attempted ids, the requesting `userId`, and the
 * internal reason. This is the first signal of an authorization bug or a probing
 * attempt, so it is deliberately noisier than the 404 the caller sees.
 *
 * `repositoryId`/`pullRequestId`/`reviewId` are emitted only on the path that resolved
 * that far, so the project-only-path log line is byte-for-byte what phase 01 emitted and
 * existing log queries keep working.
 *
 * The message is always "Project not found" — including for a repository, a pull
 * request, or a review. Saying "Review not found" would confirm that the id names a
 * review at all, which is the same oracle in a smaller box.
 */
function denied(denial: Denial): NotFoundError {
  logger.warn("tenant access denied", {
    projectId: denial.projectId,
    userId: denial.userId,
    reason: denial.reason,
    ...(denial.repositoryId ? { repositoryId: denial.repositoryId } : {}),
    ...(denial.pullRequestId ? { pullRequestId: denial.pullRequestId } : {}),
    ...(denial.reviewId ? { reviewId: denial.reviewId } : {}),
  });
  return new NotFoundError("Project not found");
}
