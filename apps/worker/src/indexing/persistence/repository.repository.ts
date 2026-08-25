import { Prisma, prisma } from "@repo/db";

/**
 * `repository-index.ts`'s own access to the `Repository` table — the lock, the
 * index-target read, and the two terminal writes. A separate file from
 * `apps/api/src/modules/repositories/repository.repository.ts`: that file lives inside
 * `apps/api`'s own source tree, and this monorepo has no cross-app source imports (each
 * deployable only depends on `packages/*`). Rule B (phase-00 §3) requires every Prisma
 * query to live in a `*.repository.ts` file regardless of which app it is in, so the
 * worker gets its own, narrow one — it needs a handful of `Repository` operations, not
 * the whole surface `apps/api`'s own file exposes (connect, list, disconnect, ...).
 */

const LOCKABLE_STATUSES = ["PENDING", "FAILED", "INDEXED"] as const;

export type AcquireLockResult = { acquired: true } | { acquired: false };

/**
 * `plan.md` §8.2 step 1 / phase-03 §11: `UPDATE Repository SET indexStatus='INDEXING'
 * WHERE indexStatus IN ('PENDING','FAILED','INDEXED')`. `updateMany`'s `count` is the
 * whole mechanism — `0` means another run already holds the lock (or the repository is
 * mid-index already), `1` means this run just won it. There is no `SELECT` before the
 * `UPDATE`: a check-then-act would race exactly the way this lock exists to prevent.
 */
export async function acquireIndexingLock(repositoryId: string): Promise<AcquireLockResult> {
  const result = await prisma.repository.updateMany({
    where: { id: repositoryId, indexStatus: { in: [...LOCKABLE_STATUSES] } },
    data: { indexStatus: "INDEXING" },
  });
  return { acquired: result.count === 1 };
}

export interface StalePendingRepository {
  id: string;
  projectId: string;
}

/**
 * `stale-index-sweeper`'s own query (phase-03's resolution to `emit.ts`'s
 * `TODO(phase-03)` — see that file and docs/decisions/phase-03-log.md). Finds
 * repositories stuck `PENDING` — meaning their `repository/index.requested` event was
 * never processed, dropped or otherwise — for at least `olderThanMs`, so a repository
 * that connected moments ago and simply hasn't been picked up *yet* is not re-swept on
 * every cron tick. `updatedAt` is the staleness signal: nothing ever writes to a
 * genuinely stuck row, so it stays pinned at connect time.
 *
 * Deliberately imprecise, on purpose: a false positive (a real run is in flight but has
 * not yet updated `indexStatus` away from `PENDING`) costs nothing — `acquireIndexingLock`
 * is the actual safety net, and a redundant `repository/index.requested` for an
 * already-running repository simply fails to acquire the lock and exits gracefully
 * (§11/§12). This query only ever has to be a reasonable heuristic for "probably stuck",
 * not a proof.
 */
export async function findStalePending(olderThanMs: number): Promise<StalePendingRepository[]> {
  return prisma.repository.findMany({
    where: { indexStatus: "PENDING", updatedAt: { lt: new Date(Date.now() - olderThanMs) } },
    select: { id: true, projectId: true },
  });
}

export interface IndexTarget {
  owner: string;
  name: string;
  defaultBranch: string;
  installationId: bigint;
  projectId: string;
  indexedCommitSha: string | null;
}

/**
 * Everything step 2 needs, read in one query right after the lock is won. `owner`/`name`/
 * `defaultBranch` come from the row Phase 02's connect flow already populated from a
 * fresh `GET /repos/{o}/{r}` call — **not** re-fetched here. See
 * docs/decisions/phase-03-log.md for the argument: re-fetching metadata on every index
 * run would make this phase's own stated acceptance criterion ("exactly two GitHub API
 * calls per full index run" — phase-03 §9/§14/§15) unsatisfiable, since resolving the SHA
 * already costs one call (`getHeadCommit`) and the tarball fetch costs the second.
 */
export async function findIndexTarget(repositoryId: string): Promise<IndexTarget | null> {
  return prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { owner: true, name: true, defaultBranch: true, installationId: true, projectId: true, indexedCommitSha: true },
  });
}

export interface MarkIndexedInput {
  repositoryId: string;
  commitSha: string;
  indexedFileCount: number;
  skippedFileCount: number;
}

/** This phase's terminal step (phase-03 §1/§8): `Repository.indexStatus = INDEXED` in
 * this phase's limited sense — "the file inventory is complete", nothing about symbols
 * or embeddings. `indexError` is explicitly cleared (`Prisma.JsonNull`, not a bare `null`
 * — Prisma's own distinction between "set this JSON column to SQL NULL" and other
 * null-handling ambiguities) so a stale failure from a previous run does not linger
 * beside a now-successful `INDEXED` status. */
export async function markIndexed(input: MarkIndexedInput): Promise<void> {
  await prisma.repository.update({
    where: { id: input.repositoryId },
    data: {
      indexStatus: "INDEXED",
      indexedCommitSha: input.commitSha,
      lastIndexedAt: new Date(),
      indexedFileCount: input.indexedFileCount,
      skippedFileCount: input.skippedFileCount,
      indexError: Prisma.JsonNull,
    },
  });
}

export interface MarkFailedInput {
  repositoryId: string;
  code: string;
  message: string;
}

/** `indexError` carries the same `{ code, message }` shape `IndexJob.error` does
 * (index-job.repository.ts's `markFailed`) — never a stack trace, never attack detail
 * for `UNSAFE_ARCHIVE` (§12). */
export async function markFailed(input: MarkFailedInput): Promise<void> {
  await prisma.repository.update({
    where: { id: input.repositoryId },
    data: { indexStatus: "FAILED", indexError: { code: input.code, message: input.message } },
  });
}
