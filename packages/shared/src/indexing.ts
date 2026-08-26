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
// RepositoryFile.classification
// ---------------------------------------------------------------------------

/**
 * `RepositoryFile.classification` **is** a real Postgres/Prisma enum (`FileClassification`
 * in schema.prisma) — unlike every other union in this file, which pins a plain `String`
 * column's legal values. It is mirrored here anyway, deliberately, rather than having
 * every consumer import the type from `@repo/db`'s generated client:
 *
 * `packages/db/src/index.ts`'s barrel re-exports `prisma` from `./client.ts`, and
 * `client.ts` reads `process.env.DATABASE_URL` and **throws at module-load time** if it
 * is unset (`packages/db/src/client.ts`) — a real, load-bearing fail-fast for the actual
 * database connection, not a bug to fix there. But it means importing *anything* from
 * `@repo/db`'s public surface — including a pure, side-effect-free enum with no
 * connection to open — pulls that throw into the importer's module graph. Prompt 2
 * discovered this the direct way: `file-classifier.ts` (apps/worker/src/indexing/filter/,
 * no database access, no `*.repository.ts` involvement) needs the `FileClassification`
 * vocabulary to build its return value, and its unit tests have no `DATABASE_URL`
 * configured (correctly — they are pure-function tests over buffers and strings).
 *
 * So `FileClassification` is treated the same way `IndexState`/`SkipReason`/etc. already
 * are: pinned here, in `@repo/shared`, matched string-for-string against
 * `schema.prisma`'s enum. `apps/worker/src/indexing/persistence/repository-file.repository.ts`
 * (the one `*.repository.ts` file that actually writes this column) is the only place in
 * the system that ever imports the real Prisma-generated enum type, and the two are
 * structurally identical string-literal unions, so passing a `@repo/shared` value into a
 * Prisma `data.classification` field requires no cast.
 */
export const FILE_CLASSIFICATIONS = [
  "SOURCE",
  "TEST",
  "CONFIG",
  "GENERATED",
  "DEPENDENCY_LOCK",
  "DOCUMENTATION",
  "ASSET",
  "UNKNOWN",
] as const;
export type FileClassification = (typeof FILE_CLASSIFICATIONS)[number];

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
 * Widened from the single-value `["OK"]` Phase 03 deliberately pinned (see that
 * commit's own comment, and phase-04's prompt-1 §2.5) — this is the compile-error
 * forcing-function actually firing: every call site that assigned/compared the old
 * literal type now has to say which of the three real states it means, rather than the
 * widening happening silently as a `string`.
 *
 * `"OK"` — parse succeeded, symbols extracted. `"FAILED"` — tree-sitter either threw or
 * returned a tree whose error-node tolerance was exceeded (Prompt 2's adapter decides
 * the threshold); the file stays indexed for Phase 05's text/semantic search, only its
 * symbol/edge data is missing (§1 non-negotiable rule 4: one malformed file never fails
 * a repository index). `"NOT_PARSED"` — this file was never eligible for parsing at all:
 * wrong language, `indexState=SKIPPED`, or binary/over-size-cap. Deliberately not named
 * `"SKIPPED"`, which already means something specific on `RepositoryFile.indexState`/
 * `skipReason` — a `NOT_PARSED` file can have `indexState="INDEXED"` (a `.json` or
 * `.md` file: successfully indexed, just not a parseable language).
 */
export const PARSE_STATES = ["OK", "FAILED", "NOT_PARSED"] as const;
export type ParseState = (typeof PARSE_STATES)[number];
export function isParseState(value: unknown): value is ParseState {
  return typeof value === "string" && (PARSE_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// CodeSymbol.kind
// ---------------------------------------------------------------------------

/**
 * `CodeSymbol.kind` is a plain `String` column (phase-04 §6's own Prisma block), not a
 * Postgres enum — same asymmetry as `RepositoryFile.indexState`/`skipReason` above, for
 * the same reason: `apps/worker` writes it (the parser/graph-builder), and any future
 * consumer that reads `CodeSymbol` rows across a package boundary must not re-derive the
 * vocabulary. Sourced from `plan.md` §10.2's own symbol list, not invented here.
 */
export const SYMBOL_KINDS = [
  "FUNCTION",
  "ARROW_FUNCTION",
  "CLASS",
  "METHOD",
  "INTERFACE",
  "TYPE_ALIAS",
  "ENUM",
  "REACT_COMPONENT",
  "HOOK",
  "VARIABLE",
] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];
export function isSymbolKind(value: unknown): value is SymbolKind {
  return typeof value === "string" && (SYMBOL_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// CodeDependency.resolution
// ---------------------------------------------------------------------------

/**
 * `CodeDependency.resolution` — a plain `String` column defaulting to `"RESOLVED"`;
 * phase-04 §6's own inline comment already names the complete three-value vocabulary
 * (`RESOLVED | EXTERNAL | UNRESOLVED`), mirrored here rather than left as an
 * un-typed default string for the same producer/consumer reason as every other union in
 * this file.
 */
export const DEPENDENCY_RESOLUTIONS = ["RESOLVED", "EXTERNAL", "UNRESOLVED"] as const;
export type DependencyResolution = (typeof DEPENDENCY_RESOLUTIONS)[number];
export function isDependencyResolution(value: unknown): value is DependencyResolution {
  return typeof value === "string" && (DEPENDENCY_RESOLUTIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// CodeDependency.kind
// ---------------------------------------------------------------------------

/**
 * Mirrors the real `DependencyKind` Prisma **enum** (`schema.prisma`) — unlike every
 * other union in this file, `kind` is a genuine Postgres enum, not a plain `String`
 * column. Mirrored here anyway, for the identical reason `FILE_CLASSIFICATIONS` above is
 * mirrored rather than imported from `@repo/db`: importing anything from `@repo/db`'s
 * public surface pulls in `client.ts`'s module-load-time `DATABASE_URL` throw, which the
 * parsing layer's pure-function unit tests (no database, no `*.repository.ts` involved)
 * must not require. `apps/worker/src/indexing/graph/graph-builder.ts` (the one
 * `*.repository.ts`-adjacent module that actually writes this column) is the only place
 * that ever imports the real Prisma-generated enum type; the two are structurally
 * identical string-literal unions, so passing a `@repo/shared` value into a Prisma
 * `data.kind` field requires no cast.
 */
export const DEPENDENCY_KINDS = [
  "IMPORTS",
  "EXPORTS",
  "CONTAINS",
  "CALLS",
  "EXTENDS",
  "IMPLEMENTS",
  "REFERENCES",
  "TESTS",
] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];
export function isDependencyKind(value: unknown): value is DependencyKind {
  return typeof value === "string" && (DEPENDENCY_KINDS as readonly string[]).includes(value);
}

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
 * REPO_NOT_FOUND) and needs to be stable across the producers that set it. Prompt 1
 * covered the codes `tarball-fetcher.ts`/`archive-extractor.ts` can produce on their
 * own; Prompt 2 (`repository-index.ts`) extends the same union with the one additional
 * outcome those modules cannot themselves distinguish — see `ACCESS_REVOKED` below —
 * rather than starting a second, parallel vocabulary (docs/decisions/phase-03-log.md).
 */
export const INDEX_ERROR_CODES = [
  /** Tarball or metadata call returned 404 — repository deleted, renamed, or the
   * installation can no longer see it. Non-retriable. */
  "REPO_NOT_FOUND",
  /** Tarball download exhausted its retries against a 5xx or a network failure. */
  "TARBALL_DOWNLOAD_FAILED",
  /** archive-extractor rejected a hostile entry (path traversal, symlink escape, etc.),
   * or the tarball fetch's redirect target failed the codeload.github.com pin (the same
   * "this looks tampered with, abort, do not retry, do not leak detail" family — see
   * tarball-fetcher.ts's own `UNSAFE_REDIRECT` result variant). Non-retriable — attack
   * details are logged, never surfaced past this code. */
  "UNSAFE_ARCHIVE",
  /** Extraction exceeded INDEX_MAX_TOTAL_BYTES or INDEX_MAX_FILE_COUNT. Non-retriable. */
  "REPO_TOO_LARGE",
  /** The installation's token mint came back 401 mid-run (`GithubAccessRevokedError`) —
   * distinct from `REPO_NOT_FOUND`: the repository still exists, but the App's access to
   * it was revoked, suspended, or uninstalled since the repository connected.
   * Non-retriable, per `plan.md` §27.5 rule 5 ("installation revoked" is named
   * explicitly as a case that must not retry). */
  "ACCESS_REVOKED",
] as const;
export type IndexErrorCode = (typeof INDEX_ERROR_CODES)[number];
