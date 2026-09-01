import { prisma } from "@repo/db";

/**
 * Prisma queries only — no business logic, no logging. Only files matching
 * `*.repository.ts` (and `packages/db/**`) may import `@repo/db`'s Prisma-backed
 * exports (Rule B, phase-00 §3).
 *
 * Phase 07 sub-task 1.5 — the module `requireTenantAccess` resolves a `pullRequestId`
 * through. This is a **distinct module** from
 * `apps/api/src/modules/webhooks/pull-request.repository.ts` (Phase 06's own
 * `upsertMinimal`, the webhook module's narrow six-field write path) — Rule D keeps the
 * webhooks module free of anything reaching *into* it from elsewhere, and this module's
 * read is a tenancy-check concern, not a webhook-ingestion one. Two files, same table,
 * two different reasons to touch it.
 */

/**
 * The minimal projection `requireTenantAccess` needs to decide ownership of a pull
 * request, with the whole `PullRequest → Repository → Project → userId` chain resolved
 * in a **single query** — the identical discipline `repository.repository.ts`'s own
 * `findOwnershipById` already establishes for the repository link one step down.
 */
export interface PullRequestOwnership {
  id: string;
  projectId: string;
  repositoryId: string;
  userId: string;
  projectDeletedAt: Date | null;
}

/**
 * The **one deliberately owner-unscoped read in this module** — mirrors
 * `repository.repository.ts`'s own `findOwnershipById` exactly: unscoped because a
 * `where: { id, repository: { project: { userId } } }` lookup can only answer yes/no,
 * which makes "not yours" and "does not exist" indistinguishable in the log line
 * `tenant-access.ts`'s `denied()` writes — and phase-01 §20 requires the warn line to
 * say which. The caller-visible answer is 404 either way, so nothing leaks: the row
 * never leaves the tenancy check, only the columns it decides from.
 */
export async function findOwnershipById(
  pullRequestId: string,
): Promise<PullRequestOwnership | null> {
  const row = await prisma.pullRequest.findUnique({
    where: { id: pullRequestId },
    select: {
      id: true,
      repositoryId: true,
      repository: {
        select: {
          projectId: true,
          project: { select: { userId: true, deletedAt: true } },
        },
      },
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    repositoryId: row.repositoryId,
    projectId: row.repository.projectId,
    userId: row.repository.project.userId,
    projectDeletedAt: row.repository.project.deletedAt,
  };
}
