import { prisma } from "@repo/db";

/**
 * Prisma queries only — no business logic, no logging. Only files matching
 * `*.repository.ts` (and `packages/db/**`) may import `@repo/db`'s Prisma-backed
 * exports (Rule B, phase-00 §3).
 *
 * Phase 07 sub-task 1.5 — the module `requireTenantAccess` resolves a `reviewId`
 * through, one link further up the same chain `apps/api/src/modules/pull-requests/
 * pull-request.repository.ts` (this phase's own sibling module) resolves a
 * `pullRequestId` through.
 */

/**
 * The minimal projection `requireTenantAccess` needs to decide ownership of a review,
 * with the whole `Review → PullRequest → Repository → Project → userId` chain resolved
 * in a **single query** — the same discipline every sibling `findOwnershipById` in this
 * codebase already establishes.
 */
export interface ReviewOwnership {
  id: string;
  projectId: string;
  repositoryId: string;
  pullRequestId: string;
  userId: string;
  projectDeletedAt: Date | null;
}

/**
 * The **one deliberately owner-unscoped read in this module** — see
 * `repository.repository.ts`'s own `findOwnershipById` for the fuller argument this
 * follows exactly, one more hop up the chain.
 *
 * Resolves through the `pullRequest` relation, **not** through `Review.projectId`/
 * `repositoryId` (the two denormalized convenience columns `schema.prisma`'s own
 * `Review` model comment argues for). Those columns exist so a caller that already has
 * them in hand can skip a join for logging/scoping a query; they are not the
 * authoritative ownership chain, and trusting them here would let a hand-edited or
 * future-bug-drifted denormalized column silently grant access `requireTenantAccess`
 * was supposed to deny.
 */
export async function findOwnershipById(
  reviewId: string,
): Promise<ReviewOwnership | null> {
  const row = await prisma.review.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      pullRequestId: true,
      pullRequest: {
        select: {
          repositoryId: true,
          repository: {
            select: {
              projectId: true,
              project: { select: { userId: true, deletedAt: true } },
            },
          },
        },
      },
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    pullRequestId: row.pullRequestId,
    repositoryId: row.pullRequest.repositoryId,
    projectId: row.pullRequest.repository.projectId,
    userId: row.pullRequest.repository.project.userId,
    projectDeletedAt: row.pullRequest.repository.project.deletedAt,
  };
}
