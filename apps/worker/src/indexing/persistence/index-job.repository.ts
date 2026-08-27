import { prisma } from "@repo/db";
import type { IndexErrorCode, IndexJobMode } from "@repo/shared";

/**
 * `plan.md` §27.6: "Inngest is the executor, Postgres is the status of record." Every
 * `IndexJob` write in `repository-index.ts` goes through this file — the *.repository.ts
 * suffix required by ESLint Rule B (phase-00 §3).
 *
 * ## The documented `PENDING → RUNNING → SUCCEEDED|FAILED` lifecycle is compressed to
 * one transition here, deliberately
 *
 * §11's state diagram shows `IndexJob.status` starting at `PENDING`, then moving to
 * `RUNNING`. This module never writes `PENDING` — {@link createIndexJob} inserts the row
 * already `RUNNING`, with `startedAt` set. Reasoning: the earliest safe moment to create
 * an `IndexJob` row at all is *after* the locking `UPDATE Repository SET
 * indexStatus='INDEXING' ...` in step 1 has confirmed this run actually won the lock —
 * creating the row *before* that confirmation would mean either backing out an orphan
 * row on the "zero rows affected, exit gracefully" path (§11/§12), or leaving one
 * behind. By the time it is safe to create the row, the run has already, unambiguously,
 * started; there is no real intermediate "queued but not yet running" moment for a
 * `PENDING` `IndexJob` row to represent, distinct from Inngest's own pre-function queue
 * (which has no row at all). See docs/decisions/phase-03-log.md for the fuller argument.
 * `PENDING` remains a legal value in `@repo/shared`'s `IndexJobStatus` union because a
 * later phase (or a future queueing strategy) may reintroduce a real use for it — the
 * column is not narrowed, only this phase's writer never produces that value.
 *
 * ## Counter definitions — binding, because §14's reconciliation check depends on them
 *
 * - **`filesTotal`** = every path that reached a `RepositoryFile` row this run —
 *   `INDEXED + SKIPPED + FAILED`. **Never** includes hard-ignored paths (they get no
 *   row at all — ignore-rules.ts's own contract; see walk-tree.ts's `WalkSummary`,
 *   where this is `files.length`, not `pathsConsidered`).
 * - **`filesProcessed`** = `INDEXED + FAILED` — every file the pipeline actually
 *   finished running its own read/classify/hash attempt against, whether that attempt
 *   succeeded (`INDEXED`) or failed (`FAILED`). "Processed" means "attempted to
 *   completion", not "succeeded".
 * - **`filesSkipped`** = `SKIPPED` (any `skipReason`) — files deliberately excluded by
 *   *policy* (size cap, binary, minified, generated, vendored) without the pipeline ever
 *   attempting to read them for indexing purposes.
 *
 * By construction, `filesProcessed + filesSkipped === filesTotal` always holds for a
 * completed walk — this is §14's Database Verification invariant, made true by
 * definition rather than asserted after the fact. §12's own table ("visible in
 * filesSkipped/filesProcessed counts" for a `FAILED` file) is honored by folding
 * `FAILED` into `filesProcessed`, not `filesSkipped` — a failed-to-read file was not
 * skipped by policy, the pipeline tried and could not finish.
 */

export interface IndexJobRecord {
  id: string;
  repositoryId: string;
  mode: string;
  status: string;
  targetCommitSha: string | null;
  previousCommitSha: string | null;
  inngestRunId: string | null;
  filesTotal: number;
  filesProcessed: number;
  filesSkipped: number;
  currentStep: string | null;
  progressPercent: number;
  startedAt: Date | null;
  completedAt: Date | null;
  error: unknown;
  attempts: number;
  createdAt: Date;
}

export interface CreateIndexJobInput {
  repositoryId: string;
  mode: IndexJobMode;
  inngestRunId: string;
  /** `POST /api/repositories/:id/index` (apps/api) pre-generates this and rides it on
   * the triggering event, because that route must return `{ indexJobId }` synchronously
   * — before this function ever runs (§7). When present, this row adopts that id
   * instead of letting Prisma generate one, so the id the client received is the id
   * this row actually gets. Absent on the `connectRepository` path, which has no
   * synchronous caller waiting on an id — Prisma generates one as before. */
  id?: string;
}

/** Inserts the run's `IndexJob` row already `RUNNING` (see this module's header
 * comment). `attempts` starts at 1 — this call itself is the run's first attempt;
 * {@link incrementAttempts} accounts for every attempt after it. */
export async function createIndexJob(
  input: CreateIndexJobInput,
): Promise<IndexJobRecord> {
  return prisma.indexJob.create({
    data: {
      ...(input.id ? { id: input.id } : {}),
      repositoryId: input.repositoryId,
      mode: input.mode,
      status: "RUNNING",
      inngestRunId: input.inngestRunId,
      startedAt: new Date(),
      attempts: 1,
      currentStep: "acquire-lock",
      progressPercent: 0,
    },
  });
}

/**
 * `repository-index.ts`'s `onFailure` handler runs as a fresh, separate invocation with
 * no closure over the main handler's `job` variable — it only has the *original*
 * triggering event and Inngest's own `run_id`, which is exactly why {@link createIndexJob}
 * stores `inngestRunId` at all. This is the lookup that reconnects the two. Returns
 * `null` if the run failed before step 1 ever created a row (e.g. a transient DB error
 * on the very first write) — `onFailure` treats that as "nothing to mark", not an error.
 */
export async function findByInngestRunId(
  inngestRunId: string,
): Promise<IndexJobRecord | null> {
  return prisma.indexJob.findFirst({
    where: { inngestRunId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Called once per genuine retry (never on the run's first attempt — see
 * repository-index.ts's own use of `ctx.attempt` to decide when this runs), so
 * `attempts` reflects how many times this run's function body has actually executed
 * from the top, not how many *steps* within it happened to retry individually.
 */
export async function incrementAttempts(jobId: string): Promise<void> {
  await prisma.indexJob.update({
    where: { id: jobId },
    data: { attempts: { increment: 1 } },
  });
}

export interface ProgressUpdate {
  currentStep: string;
  progressPercent: number;
  targetCommitSha?: string;
  previousCommitSha?: string;
  filesTotal?: number;
  filesProcessed?: number;
  filesSkipped?: number;
}

/**
 * A single, generic step-boundary update — `repository-index.ts` decides *when* to call
 * this (the cadence is a function-level decision, see docs/decisions/phase-03-log.md),
 * this function just performs whichever fields the caller supplies. Only the fields
 * present in `update` are written; omitted optional fields are left untouched, so a
 * step that only advances `currentStep`/`progressPercent` (most of them) does not need
 * to re-supply counters it has no new value for.
 */
export async function updateProgress(
  jobId: string,
  update: ProgressUpdate,
): Promise<void> {
  await prisma.indexJob.update({
    where: { id: jobId },
    data: {
      currentStep: update.currentStep,
      progressPercent: update.progressPercent,
      ...(update.targetCommitSha !== undefined
        ? { targetCommitSha: update.targetCommitSha }
        : {}),
      ...(update.previousCommitSha !== undefined
        ? { previousCommitSha: update.previousCommitSha }
        : {}),
      ...(update.filesTotal !== undefined
        ? { filesTotal: update.filesTotal }
        : {}),
      ...(update.filesProcessed !== undefined
        ? { filesProcessed: update.filesProcessed }
        : {}),
      ...(update.filesSkipped !== undefined
        ? { filesSkipped: update.filesSkipped }
        : {}),
    },
  });
}

/** Terminal success — `progressPercent` is forced to 100 rather than trusting whatever
 * the last `updateProgress` call left it at, so a rounding gap in an intermediate
 * cadence can never leave a `SUCCEEDED` job visibly stuck below 100% in the UI.
 * `symbolsCreated`/`edgesCreated` (Phase 04, sub-task 4.6) are optional so the no-op
 * path (`markSucceededNoOp`, below) and any other caller with nothing to report can omit
 * them without writing `0` over a value that was never actually computed this run. */
export async function markSucceeded(
  jobId: string,
  finalCounts: {
    filesTotal: number;
    filesProcessed: number;
    filesSkipped: number;
    symbolsCreated?: number;
    edgesCreated?: number;
  },
): Promise<void> {
  await prisma.indexJob.update({
    where: { id: jobId },
    data: {
      status: "SUCCEEDED",
      currentStep: "completed",
      progressPercent: 100,
      completedAt: new Date(),
      filesTotal: finalCounts.filesTotal,
      filesProcessed: finalCounts.filesProcessed,
      filesSkipped: finalCounts.filesSkipped,
      ...(finalCounts.symbolsCreated !== undefined
        ? { symbolsCreated: finalCounts.symbolsCreated }
        : {}),
      ...(finalCounts.edgesCreated !== undefined
        ? { edgesCreated: finalCounts.edgesCreated }
        : {}),
    },
  });
}

export interface JobError {
  code: IndexErrorCode | "UNKNOWN";
  message: string;
  step?: string;
}

/**
 * Terminal failure. `error` is a structured `{ code, message, step }` (the prompt's own
 * required shape) — never a stack trace, never a token or signed URL (§4 Security: no
 * secret ever reaches a persisted, UI-readable column). Callers pass a short, generic
 * `message` for exactly the cases §12 says must not leak attack detail
 * (`UNSAFE_ARCHIVE`); the full detail goes to the structured log line instead.
 */
export async function markFailed(
  jobId: string,
  error: JobError,
): Promise<void> {
  await prisma.indexJob.update({
    where: { id: jobId },
    data: {
      status: "FAILED",
      currentStep: error.step ?? "failed",
      completedAt: new Date(),
      error: {
        code: error.code,
        message: error.message,
        ...(error.step ? { step: error.step } : {}),
      },
    },
  });
}

/** No-op path (§8's "already indexed at this SHA" short-circuit, and §11/§12's
 * lock-contention exit) — the job that WON the race still needs a clean terminal state
 * even though it did none of steps 3–6. `filesTotal`/`filesProcessed`/`filesSkipped`
 * are deliberately left at their `0` defaults: nothing was walked, so there is nothing
 * to report, and reporting 0/0/0 is honest rather than copying stale counts from a
 * previous run's job row. */
export async function markSucceededNoOp(jobId: string): Promise<void> {
  await prisma.indexJob.update({
    where: { id: jobId },
    data: {
      status: "SUCCEEDED",
      currentStep: "no-op-already-indexed",
      progressPercent: 100,
      completedAt: new Date(),
    },
  });
}
