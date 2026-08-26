import type { OwnerContext, TenantContext } from "../../lib/auth/tenant-access.js";
import { ConflictError, NotFoundError } from "../../lib/errors.js";
import { createLogger } from "@repo/observability";
import { emitProjectDeleted } from "../../inngest/emit.js";
import * as repositoryService from "../repositories/repository.service.js";
import * as projectRepository from "./project.repository.js";
import type { CreateProjectInput, ListProjectsQuery } from "./project.schema.js";
import {
  toProjectDto,
  type ProjectDetail,
  type ProjectDto,
  type ProjectListPage,
  type ProjectRecord,
} from "./project.types.js";

/**
 * Business logic for projects. Every function takes the tenant context as its
 * **required first argument** (plan.md §34.2) — collection operations take an
 * `OwnerContext`, single-project operations take the `TenantContext` that
 * `requireTenantAccess` already resolved. It is never optional and never derived from
 * a request object: this module has no idea what an HTTP request is.
 */

const logger = createLogger("project.service");

/** Slug parts longer than this get truncated. Comfortably under the column's limits
 * and long enough that truncation is rare for a name capped at 100 chars. */
const MAX_SLUG_LENGTH = 80;

/** Used when a name contains nothing sluggable at all (e.g. "🙂🙂🙂"). The name is
 * still stored verbatim; only the URL-safe derivative falls back. */
const SLUG_FALLBACK = "project";

/**
 * Derives the URL-safe, per-user-unique slug from a display name (phase-01 §4:
 * "slugs are derived and unique per user"). Pure and exported so its edge cases —
 * accents, punctuation runs, leading/trailing separators, non-Latin names — are unit
 * testable without a database.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    // Strip combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    // The slice can leave a trailing separator behind.
    .replace(/-+$/g, "");

  return slug.length > 0 ? slug : SLUG_FALLBACK;
}

/** Escapes a slug for use inside the `^base-(\d+)$` matcher below. Slugs are already
 * `[a-z0-9-]`, so only `-` is meaningful — but escaping defensively keeps this correct
 * if the character set is ever widened. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Picks the numeric suffix for the single retry: one past the highest `base-N`
 * already claimed by this user, or `2` if only the bare `base` is taken.
 *
 * Deterministic rather than random so a user who names two projects "API" gets
 * `api` and `api-2`, not `api-7431`.
 */
export function nextSuffixedSlug(base: string, taken: readonly string[]): string {
  const pattern = new RegExp(`^${escapeRegExp(base)}-(\\d+)$`);
  let highest = 1;

  for (const slug of taken) {
    const match = pattern.exec(slug);
    if (!match?.[1]) continue;
    const suffix = Number.parseInt(match[1], 10);
    if (Number.isFinite(suffix) && suffix > highest) {
      highest = suffix;
    }
  }

  return `${base}-${highest + 1}`;
}

/**
 * Creates a project, resolving a slug collision with **exactly one retry** — not a
 * loop (phase-01 §12: "Service retries with a numeric suffix once before giving up").
 *
 * The concurrency case this is designed for (phase-01 §22, §14 Database Verification):
 * two simultaneous requests with the same name from the same user both derive the same
 * base slug, one wins the `(userId, slug)` unique constraint, and the loser retries
 * with a suffix — producing two distinct slugs, never a duplicate and never a crash.
 * With enough simultaneous requests the retry itself can lose, and that is precisely
 * when a 409 is the correct answer rather than a third attempt.
 */
export async function createProject(owner: OwnerContext, input: CreateProjectInput): Promise<ProjectDto> {
  const baseSlug = slugify(input.name);

  const firstAttempt = await projectRepository.create(owner.userId, { name: input.name, slug: baseSlug });
  if (firstAttempt.ok) {
    return created(owner, firstAttempt.project);
  }

  // Includes soft-deleted projects on purpose: they still hold their slug, because
  // `@@unique([userId, slug])` has no `deletedAt` in it (phase-01 §6/§11).
  const takenSlugs = await projectRepository.findSlugsForUserByPrefix(owner.userId, baseSlug);
  const retrySlug = nextSuffixedSlug(baseSlug, takenSlugs);

  const secondAttempt = await projectRepository.create(owner.userId, { name: input.name, slug: retrySlug });
  if (secondAttempt.ok) {
    return created(owner, secondAttempt.project);
  }

  logger.warn("project create abandoned after slug retry", {
    userId: owner.userId,
    baseSlug,
    retrySlug,
  });
  throw new ConflictError("That name is taken, try another", {
    details: { field: "name" },
  });
}

/** phase-01 §20: project mutations log at `info` with component `project.service`,
 * `projectId` and `userId`. */
function created(owner: OwnerContext, project: ProjectRecord): ProjectDto {
  logger.info("project created", {
    projectId: project.id,
    userId: owner.userId,
    slug: project.slug,
  });
  return toProjectDto(project);
}

/**
 * One page of the caller's own projects (phase-01 §7). The repository fetches
 * `limit + 1` rows; the extra one is the existence proof for `nextCursor`, so an empty
 * last page never happens.
 */
export async function listProjects(owner: OwnerContext, query: ListProjectsQuery): Promise<ProjectListPage> {
  const rows = await projectRepository.listByUser(owner.userId, {
    limit: query.limit,
    cursor: query.cursor,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    projects: page.map(toProjectDto),
    nextCursor: hasMore && last ? last.id : null,
  };
}

/**
 * Project detail (phase-01 §7). `requireTenantAccess` has already proved ownership;
 * this still re-reads through the owner-scoped query rather than trusting that
 * proof — defense in depth, and it is what closes the window where the project is
 * deleted between the tenancy check and this read.
 *
 * `repositories` carried the `never[]` marker through Phase 01 so that Phase 02 could
 * not forget to populate it; this is where that marker is cashed in. The list comes
 * from the repositories module's *service*, not its repository layer — this module has
 * no business knowing how repositories are stored, only how to ask for them.
 */
export async function getProjectDetail(tenant: TenantContext): Promise<ProjectDetail> {
  const project = await projectRepository.findByIdForUser(tenant.userId, tenant.projectId);
  if (!project) {
    throw new NotFoundError("Project not found");
  }

  const repositories = await repositoryService.listProjectRepositories(tenant);

  return { project: toProjectDto(project), repositories };
}

/**
 * Soft-delete (phase-01 §11 — no hard delete in this phase; the nightly sweep arrives
 * once there is cascading data to clean up).
 *
 * **Idempotent** (phase-01 §4 Reliability): deleting an already-deleted project
 * succeeds. `softDeleteForUser` reports `0` rows changed in that case, which also
 * means the original `deletedAt` is never overwritten by a repeat call.
 *
 * `project/deleted` is emitted only on an actual ACTIVE → SOFT_DELETED transition. An
 * event named for a state change should not fire when no state changed; the repeat
 * call still returns success, it just does not re-announce something that already
 * happened.
 */
export async function softDeleteProject(tenant: TenantContext): Promise<void> {
  const changed = await projectRepository.softDeleteForUser(tenant.userId, tenant.projectId);

  if (changed === 0) {
    logger.info("project soft-delete no-op (already deleted)", {
      projectId: tenant.projectId,
      userId: tenant.userId,
    });
    return;
  }

  logger.info("project soft-deleted", {
    projectId: tenant.projectId,
    userId: tenant.userId,
  });

  // Deliberately not awaited: the 202 must not wait on a notification channel that has
  // no consumers in this phase. `emitProjectDeleted` swallows and logs its own
  // failures, so this can never surface as an unhandled rejection — see its doc
  // comment for the measurement that motivated it.
  void emitProjectDeleted({ projectId: tenant.projectId });
}
