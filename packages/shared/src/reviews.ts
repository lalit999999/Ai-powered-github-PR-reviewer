import type { FileClassification } from "./indexing.js";
import type { PullRequestReviewRequestedData } from "./events.js";

/**
 * Type-level vocabulary and pure helpers for Phase 07's review pipeline (phase-07-pr-
 * ingestion.md §6/§17.1). Follows `indexing.ts`/`webhooks.ts`'s exact discipline: a plain
 * `String` column's legal values are pinned here as an `as const` array plus a derived
 * union — see `indexing.ts`'s own header comment for the fuller argument
 * (docs/decisions/phase-03-log.md, sub-task 1.3). `ReviewStatus` and `ReviewDepth` ARE
 * real Postgres enums (`schema.prisma`, sub-task 1.4) — mirrored here anyway, for the
 * identical `@repo/db` module-load-time `DATABASE_URL` reason `FILE_CLASSIFICATIONS` and
 * `DEPENDENCY_KINDS` already are (see `indexing.ts`'s comment on each): the worker's
 * pure-function unit tests must not need a database just to reference these values.
 *
 * `@repo/shared` is type-only and constant-only with zero runtime dependencies — no
 * Prisma, no Inngest, no logger. Everything below is a pure value or a pure function.
 */

// ---------------------------------------------------------------------------
// Review.status
// ---------------------------------------------------------------------------

/** phase-07 §6. The full Review lifecycle. WAITING_FOR_INDEX is the branch taken when a
 * repository's index is stale/PARTIAL/missing at review time (the INDEX_WAIT_TIMEOUT
 * gate below). SUPERSEDED is a review a newer commit on the same PR overtook before it
 * finished — never deleted, kept for audit history. */
export const REVIEW_STATUSES = [
  "PENDING",
  "WAITING_FOR_INDEX",
  "RUNNING",
  "AGGREGATING",
  "PUBLISHING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "SUPERSEDED",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

// ---------------------------------------------------------------------------
// Review.depth / PullRequestFile.depth — how thoroughly a file is reviewed
// ---------------------------------------------------------------------------

/** plan.md §17.1. DEEP — full LLM review with retrieved repository context. SHALLOW — a
 * lighter pass, no retrieval. SKIP — never sent to the LLM at all (e.g. a GENERATED or
 * ASSET file). */
export const REVIEW_DEPTHS = ["DEEP", "SHALLOW", "SKIP"] as const;
export type ReviewDepth = (typeof REVIEW_DEPTHS)[number];

// ---------------------------------------------------------------------------
// Review.trigger
// ---------------------------------------------------------------------------

/** What caused a Review row to be created. WEBHOOK_OPENED/WEBHOOK_SYNC are produced by
 * {@link webhookTriggerToReviewTrigger} below from the webhook action that arrived; MANUAL
 * is a user-initiated re-run; RETRY is this system re-attempting its own FAILED review. */
export const REVIEW_TRIGGERS = [
  "WEBHOOK_OPENED",
  "WEBHOOK_SYNC",
  "MANUAL",
  "RETRY",
] as const;
export type ReviewTrigger = (typeof REVIEW_TRIGGERS)[number];

// ---------------------------------------------------------------------------
// Review.contextQuality
// ---------------------------------------------------------------------------

/** FULL — `Repository.indexStatus` was INDEXED (graph and vectors both complete) at the
 * moment this review started, so `contextQuality: "FULL"` is a truthful claim (Phase 04/05
 * are what make it true). DEGRADED — the index was PARTIAL (Phase 05 embedding-provider
 * exhaustion) or stale past INDEX_STALE_AFTER_MS, and the review proceeded on whatever
 * context existed rather than blocking indefinitely. */
export const CONTEXT_QUALITIES = ["FULL", "DEGRADED"] as const;
export type ContextQuality = (typeof CONTEXT_QUALITIES)[number];

// ---------------------------------------------------------------------------
// ReviewJob.kind / ReviewJob.status
// ---------------------------------------------------------------------------

/** One `ReviewJob` row per unit of pipeline work Inngest actually schedules: the overall
 * PROCESS run, one FILE job per reviewed file, the AGGREGATE step, and the PUBLISH step
 * that posts results back to GitHub. Postgres mirror of Inngest run state (plan.md §27.6:
 * "Inngest is the executor, Postgres is the status of record") — the UI polls this table,
 * never the Inngest API. */
export const REVIEW_JOB_KINDS = ["PROCESS", "FILE", "AGGREGATE", "PUBLISH"] as const;
export type ReviewJobKind = (typeof REVIEW_JOB_KINDS)[number];

/** Deliberately narrower than {@link REVIEW_STATUSES} above — a single job unit never
 * goes WAITING_FOR_INDEX/AGGREGATING/PUBLISHING/CANCELLED/SUPERSEDED; those describe the
 * Review as a whole, not one job within it. */
export const REVIEW_JOB_STATUSES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
] as const;
export type ReviewJobStatus = (typeof REVIEW_JOB_STATUSES)[number];

// ---------------------------------------------------------------------------
// PullRequestFile.status — GitHub's own per-file diff status
// ---------------------------------------------------------------------------

/** GitHub's own `GET /pulls/{n}/files` `status` field, copied verbatim — the same
 * "keep GitHub's own spelling rather than re-casing it" choice `webhooks.ts`'s
 * `PULL_REQUEST_STATES` already makes, for the identical reason: this value is written
 * straight out of the API response and never derived, so re-casing it would create a
 * second spelling of the same fact to keep in sync. */
export const PULL_REQUEST_FILE_STATUSES = [
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
] as const;
export type PullRequestFileStatus = (typeof PULL_REQUEST_FILE_STATUSES)[number];

// ---------------------------------------------------------------------------
// PullRequestFile.reviewStatus — this system's own per-file progress
// ---------------------------------------------------------------------------

/** Per-file progress through the review pipeline — independent of
 * {@link PullRequestFileStatus} above (GitHub's add/remove/modify classification of the
 * *diff*, not this system's review progress). SKIPPED covers both `depth: "SKIP"` files
 * and files dropped past MAX_FILES_CONSIDERED. */
export const PULL_REQUEST_FILE_REVIEW_STATUSES = [
  "PENDING",
  "RUNNING",
  "DONE",
  "FAILED",
  "SKIPPED",
] as const;
export type PullRequestFileReviewStatus =
  (typeof PULL_REQUEST_FILE_REVIEW_STATUSES)[number];

// ---------------------------------------------------------------------------
// Tunable caps and durations — each sourced, not invented
// ---------------------------------------------------------------------------

/** Bumped when the review pipeline's semantics change in a way that must invalidate
 * every existing idempotency key (a scoring bug fix, a new depth rule, ...) — the last
 * segment {@link buildIdempotencyKey} builds. Bumping this means every in-flight PR gets
 * a fresh Review row on its next event rather than deduping against a run built under
 * the old semantics. */
export const REVIEW_POLICY_VERSION = "1";

/** GitHub's own hard cap on `GET /pulls/{n}/files` — this system cannot see a file past
 * this regardless of what it wants to review. */
export const MAX_FILES_FETCHED = 3000;

/** plan.md §16.4. Beyond this many changed files, the excess are still listed on the
 * Review (so the UI can show an accurate total) but never reach the LLM —
 * `reviewStatus: "SKIPPED"`. */
export const MAX_FILES_CONSIDERED = 300;

/** plan.md §16.4. DEEP-eligible files beyond this count demote to SHALLOW rather than
 * SKIPPED — a huge PR still gets a lighter pass on every file, not silence past the
 * cutoff. */
export const MAX_DEEP_FILES = 40;

/** Sub-task 1.6 (patch store). A patch at or under this size is stored inline on
 * `PullRequestFile.patchRef`; over it, it goes to `PatchBlob`. 64 KiB. */
export const PATCH_INLINE_MAX_BYTES = 64 * 1024;

/** plan.md §16.4. A single file's diff past this many lines is flagged in this phase;
 * splitting an oversized diff into reviewable pieces is Phase 08's job, not this one's. */
export const OVERSIZED_FILE_DIFF_LINES = 1500;

/** Inngest duration string — how long the index-readiness gate (`Review.status`
 * `WAITING_FOR_INDEX`) waits for a repository's index to finish before proceeding in
 * `contextQuality: "DEGRADED"` mode anyway. */
export const INDEX_WAIT_TIMEOUT = "30m";

/** An INDEXED repository whose `lastIndexedAt` is older than this triggers a background
 * refresh before/alongside the review, rather than trusting a stale index silently. */
export const INDEX_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// buildIdempotencyKey
// ---------------------------------------------------------------------------

export interface BuildIdempotencyKeyInput {
  repositoryId: string;
  prNumber: number;
  headSha: string;
  /** Defaults to {@link REVIEW_POLICY_VERSION}. Threaded through explicitly (rather than
   * only ever reading the constant) so a test can assert the key changes when the policy
   * version does, without needing to override the module-level constant. */
  policyVersion?: string;
  /** Present only for a forced manual re-run of a review that already ran at this exact
   * `(repositoryId, prNumber, headSha, policyVersion)` — appended as `:m{n}` so the
   * re-run gets its own row instead of colliding with `idempotencyKey`'s unique
   * constraint. Absent on every webhook-triggered review. */
  manualRunCounter?: number;
}

/**
 * `{repositoryId}:{prNumber}:{headSha}:{policyVersion}` — plus `:m{n}` when a forced
 * manual re-run bumps the counter. This is the ONE place the key is constructed.
 * `apps/api` builds it to look up an existing review; `apps/worker` builds it to insert
 * one. If the two ever built it differently, the concurrency guard would silently stop
 * working while every single-sided unit test kept passing.
 */
export function buildIdempotencyKey(input: BuildIdempotencyKeyInput): string {
  const policyVersion = input.policyVersion ?? REVIEW_POLICY_VERSION;
  const base = `${input.repositoryId}:${input.prNumber.toString()}:${input.headSha}:${policyVersion}`;
  return input.manualRunCounter === undefined
    ? base
    : `${base}:m${input.manualRunCounter.toString()}`;
}

// ---------------------------------------------------------------------------
// webhookTriggerToReviewTrigger
// ---------------------------------------------------------------------------

/**
 * Maps the webhook action that triggered a review to the `Review.trigger` value stored.
 * `opened`/`reopened`/`ready_for_review` all collapse to `WEBHOOK_OPENED` — all three are
 * "this PR just became reviewable for the first time at this SHA", whichever of the
 * three GitHub actions actually produced that state. `synchronize`/`sweep` collapse to
 * `WEBHOOK_SYNC` — a new commit landed on a PR already known to this system.
 */
export function webhookTriggerToReviewTrigger(
  trigger: PullRequestReviewRequestedData["trigger"],
): ReviewTrigger {
  switch (trigger) {
    case "opened":
    case "reopened":
    case "ready_for_review":
      return "WEBHOOK_OPENED";
    case "synchronize":
    case "sweep":
      return "WEBHOOK_SYNC";
  }
}

// ---------------------------------------------------------------------------
// CLASSIFICATION_REVIEW_DEPTH
// ---------------------------------------------------------------------------

/** plan.md §17.1. UNKNOWN is deliberately absent from this table — its depth depends on
 * the file's size, not its classification alone, so Prompt 3 decides it. Every other
 * classification maps unconditionally. */
export const CLASSIFICATION_REVIEW_DEPTH: Readonly<
  Record<Exclude<FileClassification, "UNKNOWN">, ReviewDepth>
> = {
  SOURCE: "DEEP",
  TEST: "SHALLOW",
  CONFIG: "SHALLOW",
  GENERATED: "SKIP",
  DEPENDENCY_LOCK: "SKIP",
  DOCUMENTATION: "SHALLOW",
  ASSET: "SKIP",
};
