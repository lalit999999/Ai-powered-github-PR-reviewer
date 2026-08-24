/**
 * Type-level vocabulary for the indexing pipeline's String-typed "enum" columns
 * (phase-03 §6). `RepositoryFile.indexState`/`skipReason`/`parseState` and
 * `IndexJob.status`/`mode` are plain `String` columns, not Postgres enums — the same
 * asymmetry `Repository.connectionStatus` already has next to the real `IndexStatus`
 * enum (docs/decisions/phase-02-log.md §5) — so the legal values are pinned here instead.
 *
 * This lives in `packages/shared`, not an app-local `*.types.ts`, because these values
 * are a genuine cross-deployable contract: `apps/worker` writes them while indexing,
 * `apps/api` reads them for the index-status endpoint (Prompt 2). That is exactly the
 * "must not drift between producer and consumer" reason `packages/shared` already holds
 * the Inngest event registry for (docs/decisions/phase-01-log.md §14) — see
 * docs/decisions/phase-03-log.md, sub-task 1.3.
 */

// ---------------------------------------------------------------------------
// RepositoryFile.indexState
// ---------------------------------------------------------------------------

/** phase-03 §6's own comment on the column: `INDEXED | SKIPPED | FAILED`. */
export const INDEX_STATES = ["INDEXED", "SKIPPED", "FAILED"] as const;
export type IndexState = (typeof INDEX_STATES)[number];
export function isIndexState(value: unknown): value is IndexState {
  return typeof value === "string" && (INDEX_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// RepositoryFile.skipReason
// ---------------------------------------------------------------------------

/**
 * §12 names `SKIPPED_TOO_LARGE` explicitly and implies the rest by describing the
 * filter pipeline's stages (plan.md §8.2 step 4): hard-ignore globs, `.gitattributes`
 * generated/vendored, the size cap, binary detection, the minified heuristic. Pinned as
 * a union — not a free-form string — because Prompt 2's filter pipeline (ignore-rules.ts,
 * file-classifier.ts) needs a fixed vocabulary to assign from, and because a downstream
 * phase branching on `skipReason` (§22: "should degrade gracefully") needs it to be
 * machine-comparable, not prose. Every value follows `indexError.code`'s
 * SCREAMING_SNAKE_CASE convention for consistency, even though `skipReason` is a plain
 * String column rather than JSON.
 *
 * If Prompt 2 discovers it needs finer granularity (e.g. splitting SKIPPED_HARD_IGNORE
 * by which glob category matched), extend this union rather than writing free text
 * beside it — a mix of pinned and ad-hoc reasons defeats the point of pinning any of it.
 */
export const SKIP_REASONS = [
  "SKIPPED_HARD_IGNORE",
  "SKIPPED_GENERATED",
  "SKIPPED_VENDORED",
  "SKIPPED_TOO_LARGE",
  "SKIPPED_BINARY",
  "SKIPPED_MINIFIED",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

// ---------------------------------------------------------------------------
// RepositoryFile.parseState
// ---------------------------------------------------------------------------

/**
 * Only "OK" is reachable before Phase 04 — every file that reaches the hashing step in
 * this phase is structurally fine as far as this phase can tell; parsing itself does not
 * exist yet (§6: "set meaningfully starting Phase 04"). Deliberately typed as the single
 * literal "OK" rather than `string`, so that Phase 04 introducing "FAILED" (plan.md §8.2
 * step 7) is a compile error at every call site instead of a silent widening — the same
 * forcing-function `RepositoryDetail.indexJob: null` already uses for Phase 03 itself
 * (docs/decisions/phase-02-log.md §26).
 */
export const PARSE_STATES = ["OK"] as const;
export type ParseState = (typeof PARSE_STATES)[number];

// ---------------------------------------------------------------------------
// IndexJob.status / IndexJob.mode
// ---------------------------------------------------------------------------

/** phase-03 §6/§11. */
export const INDEX_JOB_STATUSES = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED"] as const;
export type IndexJobStatus = (typeof INDEX_JOB_STATUSES)[number];

/**
 * §6's own comment: "FULL | INCREMENTAL (only FULL used this phase)". Both values
 * declared now — unlike `parseState` above, the *complete* vocabulary is already known,
 * not just this phase's reachable subset; INCREMENTAL is Phase 14's (plan.md §2.1/§47),
 * not an unknown future shape.
 */
export const INDEX_JOB_MODES = ["FULL", "INCREMENTAL"] as const;
export type IndexJobMode = (typeof INDEX_JOB_MODES)[number];

// ---------------------------------------------------------------------------
// Repository.indexError.code / IndexJob.error.code
// ---------------------------------------------------------------------------

/**
 * Both columns are `Json?`, so nothing at the database level constrains `.code` — but
 * the value is read by the UI (§12: "Repository card shows a reconnect CTA" for
 * REPO_NOT_FOUND) and needs to be stable across the producers that set it. Covers only
 * the codes this phase's own steps (tarball-fetcher, archive-extractor) can actually
 * produce (§12); later phases append their own rather than inventing a parallel field.
 */
export const INDEX_ERROR_CODES = [
  /** Tarball or metadata call returned 404 — repository deleted, renamed, or the
   * installation can no longer see it. Non-retriable. */
  "REPO_NOT_FOUND",
  /** Tarball download exhausted its retries against a 5xx or a network failure. */
  "TARBALL_DOWNLOAD_FAILED",
  /** archive-extractor rejected a hostile entry (path traversal, symlink escape, etc.).
   * Non-retriable — attack details are logged, never surfaced past this code. */
  "UNSAFE_ARCHIVE",
  /** Extraction exceeded INDEX_MAX_TOTAL_BYTES or INDEX_MAX_FILE_COUNT. Non-retriable. */
  "REPO_TOO_LARGE",
] as const;
export type IndexErrorCode = (typeof INDEX_ERROR_CODES)[number];
