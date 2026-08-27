import { prisma } from "@repo/db";
import type { IndexJobRecord } from "./repository.types.js";

/**
 * `apps/api`'s own, read-only view of `IndexJob` — a **separate** file from
 * `apps/worker/src/indexing/persistence/index-job.repository.ts`, which owns every
 * write. This monorepo has no cross-app source imports (each deployable depends only on
 * `packages/*`), so the two apps each get their own `*.repository.ts` for a table they
 * both touch (Rule B, phase-00 §3) — the same split `Repository`-table access already
 * takes between `apps/api/src/modules/repositories/repository.repository.ts` and
 * `apps/worker/src/indexing/persistence/repository.repository.ts`.
 *
 * `apps/api` never writes an `IndexJob` row directly — the worker's `repository-index.ts`
 * step 1 is the only writer (see that module's own header comment on why the row is
 * created `RUNNING`, not `PENDING`). This file only ever reads.
 */

const INDEX_JOB_SELECT = {
  id: true,
  repositoryId: true,
  mode: true,
  status: true,
  currentStep: true,
  progressPercent: true,
  filesTotal: true,
  filesProcessed: true,
  filesSkipped: true,
  error: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
} as const;

/**
 * The one query both `GET /api/repositories/:id` (`RepositoryDetail.indexJob`) and
 * `GET /api/repositories/:id/index-status` need — "the current index job" always means
 * the most recently created one for this repository, per `@@index([repositoryId,
 * createdAt(sort: Desc)])` (schema.prisma), which exists specifically for this query.
 */
export async function findLatestForRepository(
  repositoryId: string,
): Promise<IndexJobRecord | null> {
  return prisma.indexJob.findFirst({
    where: { repositoryId },
    orderBy: { createdAt: "desc" },
    select: INDEX_JOB_SELECT,
  });
}
