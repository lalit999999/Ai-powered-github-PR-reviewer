import { prisma } from "@repo/db";
import type { PullRequestState } from "@repo/shared";

/**
 * Prisma queries only — no business logic, no logging. Only files matching
 * `*.repository.ts` (and `packages/db/**`) may import `@repo/db`'s Prisma-backed
 * exports (Rule B, phase-00 §3).
 *
 * Owns `apps/api`'s only write path to `PullRequest` for Phase 06: the minimal row a
 * webhook payload can populate with no GitHub API call.
 */

export interface UpsertPullRequestInput {
  repositoryId: string;
  number: number;
  githubPrId: bigint;
  headSha: string;
  state: PullRequestState;
  isDraft: boolean;
}

/**
 * Keyed on the composite `@@unique([repositoryId, number])` — never on `githubPrId`
 * alone, for the identical reason `Repository` is never keyed on `githubRepoId` alone
 * (see `repository.repository.ts`'s header comment): the same GitHub pull request can
 * legitimately produce two rows here, one per project the underlying repository is
 * connected to.
 *
 * **This `update` block is additive-safe, and that is the entire point of this
 * function.** Phase 07 extends this same row with `title`, `body`, `authorLogin`,
 * `baseRef`, and more. The six fields written below are the *only* ones this function
 * ever touches — an `update` that also wrote, say, `title: null` on every webhook
 * delivery would silently wipe Phase 07's enrichment every time a `synchronize` event
 * arrived. Phase 06 §14's database verification asserts "Phase 07's enrichment is
 * additive, never destructive, when tested in sequence"; this function's narrow field
 * list is what makes that true. Do not widen it to a `...input` spread without
 * re-reading this comment.
 *
 * No GitHub API call happens here or anywhere in this phase — every field comes
 * straight out of the webhook payload the caller already has in hand.
 */
export async function upsertMinimal(input: UpsertPullRequestInput): Promise<{ id: string }> {
  return prisma.pullRequest.upsert({
    where: { repositoryId_number: { repositoryId: input.repositoryId, number: input.number } },
    create: {
      repositoryId: input.repositoryId,
      number: input.number,
      githubPrId: input.githubPrId,
      headSha: input.headSha,
      state: input.state,
      isDraft: input.isDraft,
    },
    update: {
      githubPrId: input.githubPrId,
      headSha: input.headSha,
      state: input.state,
      isDraft: input.isDraft,
    },
    select: { id: true },
  });
}
