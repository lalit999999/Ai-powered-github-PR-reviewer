import { prisma } from "@repo/db";

/**
 * Prisma queries only — no business logic, no logging. Only files matching
 * `*.repository.ts` (and `packages/db/**`) may import `@repo/db`'s Prisma-backed
 * exports (Rule B, phase-00 §3).
 *
 * **Home, and why it is not `apps/worker/src/indexing/persistence/`**: sub-task 1.6
 * suggests that directory as the default, but everything under `indexing/persistence/`
 * (`repository.repository.ts`, `repository-file.repository.ts`, `code-symbol.repository.ts`,
 * `code-dependency.repository.ts`, `index-job.repository.ts`) is the *indexing* pipeline's
 * own persistence layer — `Repository`/`RepositoryFile`/`CodeSymbol`/`CodeDependency`/
 * `IndexJob`, all written by `indexer.service.ts`'s fetch→parse→persist seam. `PatchBlob`
 * has nothing to do with indexing; it is Phase 07's own review pipeline, the same domain
 * `apps/worker/src/webhooks/webhook-event.repository.ts` already gets its own top-level
 * directory for rather than being folded into `indexing/persistence/`. This file follows
 * that exact precedent — a new top-level `reviews/` domain module, flat, matching
 * `webhooks/`'s own shape — rather than growing `indexing/persistence/` to cover a second,
 * unrelated pipeline.
 */

/**
 * Upserts on `(reviewId, path)` — never a blind insert. Required for Inngest step-retry
 * idempotency (plan.md §27.5 rule 2): a step that writes the blob and then fails before
 * its own completion is recorded will re-run, and a second `create` against the same
 * `(reviewId, path)` would violate `PatchBlob`'s own `@@unique([reviewId, path])`
 * constraint instead of harmlessly overwriting the same content a second time.
 */
export async function upsertBlob(input: {
  reviewId: string;
  path: string;
  content: string;
  byteSize: number;
}): Promise<{ id: string }> {
  return prisma.patchBlob.upsert({
    where: {
      reviewId_path: { reviewId: input.reviewId, path: input.path },
    },
    create: {
      reviewId: input.reviewId,
      path: input.path,
      content: input.content,
      byteSize: input.byteSize,
    },
    update: {
      content: input.content,
      byteSize: input.byteSize,
    },
    select: { id: true },
  });
}

/**
 * Resolves a `PatchBlob.id` back to its content. Returns `null` for a blob row that no
 * longer exists — a `Review` (and everything under it, `PatchBlob` included) can be
 * cascade-deleted between a caller reading a `patchRef` and resolving it, and that race
 * is a normal, harmless outcome here, not an error condition (`patch-store.ts`'s own
 * `resolvePatch` doc comment says the same).
 */
export async function findBlobContentById(id: string): Promise<string | null> {
  const row = await prisma.patchBlob.findUnique({
    where: { id },
    select: { content: true },
  });
  return row?.content ?? null;
}
