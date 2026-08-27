# Repository indexing (files only — Phase 03)

What gets indexed, what gets skipped and why, in what order, and where the numbers that
control it live. This is the one place that list is written down — extend it here, not
by re-deriving the rules from the source on demand (phase-03-repository-indexing.md §16
Definition of Done names this file explicitly).

Scope note: this phase indexes **files** only — no parsing, no symbols, no dependency
graph (Phase 04), no chunking or embeddings (Phase 05). `Repository.indexStatus=INDEXED`
at the end of this phase means "the file inventory is complete," nothing more; see
phase-03-repository-indexing.md §1 for how that meaning changes as later phases append
steps to the same `repository-index` Inngest function.

## The pipeline, end to end

```
repository/index.requested
  │
  ▼
1. Acquire lock + create IndexJob      (repository.repository.ts / index-job.repository.ts)
  │  UPDATE Repository SET indexStatus='INDEXING' WHERE indexStatus IN ('PENDING','FAILED','INDEXED')
  │  0 rows affected ⇒ another index is already running; exit gracefully, no error
  ▼
2. Resolve default branch + head SHA   (repository.repository.ts + @repo/github's getHeadCommit)
  │  Already indexed at this exact SHA? ⇒ mark the job SUCCEEDED as a no-op, stop here.
  ▼
3. Download the tarball                (tarball-fetcher.ts) — one GitHub API call, streamed
  ▼
4. Extract it safely                   (archive-extractor.ts) — path-traversal-proof, size/count-capped
  ▼
5. Walk the extracted tree             (walk-tree.ts) — this file's own subject, below
  │  applies the filter order, classifies, hashes, produces a WalkedFile per surviving path
  ▼
6. Persist RepositoryFile rows         (repository-file.repository.ts) — batched upsert + stale-row sweep
  ▼
Mark Repository INDEXED, set indexedCommitSha; mark IndexJob SUCCEEDED
```

Exactly **two** GitHub API calls per full run: resolving the head commit, and fetching
the tarball. Metadata (`owner`/`name`/`defaultBranch`) is read from the `Repository` row
itself — set fresh by Phase 02's connect flow — rather than re-fetched, which is what
keeps this at two calls instead of three (see `docs/decisions/phase-03-log.md`, Prompt 2
§8, for the fuller argument and the narrow staleness trade-off it accepts).

## The filter order — and why it is an order, not a set of independent checks

Applied to every candidate path, in this exact sequence, by `walk-tree.ts` composing
`ignore-rules.ts` and `file-classifier.ts`:

```
1. Hard-ignore globs           (ignore-rules.ts: isHardIgnored / isHardIgnoredDirectory)
2. .gitattributes generated/vendored   (ignore-rules.ts: classifyGitattributes)
3. Size cap                    (file-classifier.ts: isOverSizeCap)
4. Binary detection             (file-classifier.ts: detectBinary)
5. Minified heuristic           (file-classifier.ts: detectMinified)
```

A path that fails an earlier stage never reaches a later one — this matters beyond
performance: a file under `node_modules/` that happens to be 10 MB is hard-ignored (no
row at all), **not** `SKIPPED_TOO_LARGE` (a row). Getting the order backwards would be a
silent, hard-to-notice bug — it changes which paths get a database row at all, not just
which reason is recorded — and `apps/worker/src/indexing/repository-fixtures.test.ts`
asserts the order is observable end to end (a `.gitattributes`-vendored file with a NUL
byte in it comes back `SKIPPED_VENDORED`, never `SKIPPED_BINARY`, proving stage 2 runs
before stage 4 rather than merely trusting the code's own structure).

### Stage 1 — hard-ignore globs

`ignore-rules.ts`'s `HARD_IGNORE_PATTERNS` — **the one list to edit** to add or remove a
hard-ignore rule. Nothing else in the codebase encodes glob knowledge for this stage.

| Category                      | Patterns                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Dependency directories        | `node_modules/**`, `.git/**`, `vendor/**`                                                                               |
| Build output                  | `dist/**`, `build/**`, `out/**`, `.next/**`, `target/**`, `__pycache__/**`, `coverage/**`, `.venv/**`                   |
| Minified / map / bundle files | `**/*.min.js`, `**/*.min.css`, `**/*.map`, `**/*.bundle.js`                                                             |
| Lockfiles                     | `**/*.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `go.sum`, `Cargo.lock`, `poetry.lock`, `composer.lock` |
| Snapshots                     | `**/*.snap`, `**/__snapshots__/**`                                                                                      |
| Binary/asset extensions       | `**/*.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.ico`, `.pdf`, `.zip`, `.woff*`, `.ttf`, `.mp4`, `.wasm`                  |

A match here means **the path never gets a `RepositoryFile` row at all** — a structural
exclusion, not a skip. A committed `node_modules/` can be up to ~90% of a repository's
raw file count (a real, observed case — see "Repository health note" below); giving each
of those files a `SKIPPED` row would be pure write amplification with no downstream
consumer.

Directory-anchored patterns (`node_modules/**`, `dist/**`, etc.) are pruned **whole** —
the walker never descends into a hard-ignored directory at all — via
`isHardIgnoredDirectory`, which tests one synthetic child path against the same compiled
pattern set `isHardIgnored` uses. Extension/filename-anchored patterns (a bare
`pnpm-lock.yaml`, `**/*.min.js`) are checked per file during the walk, since they are not
confined to any one directory. Both paths funnel into the same "no row" outcome; only the
_mechanism_ differs, for performance on the directory case.

Patterns are compiled to `RegExp` once, at module load — never per path. A full index can
walk up to `INDEX_MAX_FILE_COUNT` (default 200,000) candidate paths; re-parsing ~40 glob
strings into regexes on every one of them would be a real, avoidable cost.

**Near-miss paths must survive.** `my-node_modules-helper.ts`, `dist-utils.ts`,
`package-lock-parser.ts` are not hard-ignored — the patterns above match whole path
segments/exact filenames, not substrings. `repository-fixtures.test.ts` asserts this
explicitly; a "cleanup" that switches a pattern to a substring match would silently start
eating real source files.

### Stage 2 — `.gitattributes` `linguist-generated` / `linguist-vendored`

Parsed by `ignore-rules.ts`'s `parseGitattributes` from the repository-root
`.gitattributes` only (nested, per-directory `.gitattributes` cascading is out of scope —
a known, accepted gap: the `linguist-generated`/`linguist-vendored` subset this phase
cares about is almost always declared once, at the root).

A match here **does** get a `RepositoryFile` row, marked `indexState=SKIPPED` with
`skipReason=SKIPPED_GENERATED` or `SKIPPED_VENDORED` — unlike stage 1, this is a
targeted, per-file signal a repository maintainer wrote on purpose, and downstream
consumers (the PR review pipeline) need to know the file exists and why it wasn't
indexed, not just silently not see it.

Semantics that matter if you touch this: a slash-free pattern (`*.pb.go`) is unanchored —
it matches at any depth, `.gitignore`-style — normalized to a `**/`-prefixed glob before
compiling, since `micromatch` has no such implicit rule and a bare `*.pb.go` would
otherwise only match a root-level file. The **last** matching rule for a given path wins
(real git attribute-resolution semantics), not the first. `generated` wins over `vendored`
when a path is flagged as both.

### Stages 3–5 — size cap, binary detection, minified heuristic

`file-classifier.ts`. Each produces a row with `indexState=SKIPPED` and a specific
`skipReason`:

| Stage              | Threshold                                                        | `skipReason`        | Notes                                                                                                                         |
| ------------------ | ---------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Size cap           | > 512 KB (`SIZE_CAP_BYTES`)                                      | `SKIPPED_TOO_LARGE` | Still hashed (streamed, never buffered) so a later incremental re-index can tell whether it changed.                          |
| Binary detection   | a NUL byte anywhere in the first 8 KB (`BINARY_SNIFF_BYTES`)     | `SKIPPED_BINARY`    | A heuristic, not a certainty — UTF-16 text is a known, accepted false positive.                                               |
| Minified heuristic | average line length > 500 chars (`MINIFIED_AVERAGE_LINE_LENGTH`) | `SKIPPED_MINIFIED`  | The _average_ over the whole file, not the longest line — one long JSON array on an otherwise normal file must not trip this. |

**The deliberate false-negative bias** (phase-03 §22): a binary file that slips past the
NUL-byte sniff still gets indexed and is re-checked by Phase 04's real parser — contained,
recoverable. A text file wrongly flagged binary disappears from review context entirely,
with nothing to re-check it. No heuristic beyond these two was added, specifically because
a third heuristic's false-positive side would only make the worse failure mode (silent
disappearance) more likely.

## The row / no-row rule — the single easiest thing to get backwards

| Outcome                                                | Gets a `RepositoryFile` row? | `indexState` | `skipReason`                                                |
| ------------------------------------------------------ | ---------------------------- | ------------ | ----------------------------------------------------------- |
| Hard-ignored (stage 1)                                 | **No**                       | —            | —                                                           |
| `.gitattributes`-declared generated/vendored (stage 2) | Yes                          | `SKIPPED`    | `SKIPPED_GENERATED` / `SKIPPED_VENDORED`                    |
| Over the size cap / binary / minified (stages 3–5)     | Yes                          | `SKIPPED`    | `SKIPPED_TOO_LARGE` / `SKIPPED_BINARY` / `SKIPPED_MINIFIED` |
| Survives every stage                                   | Yes                          | `INDEXED`    | `null`                                                      |
| Unreadable/corrupt during hashing                      | Yes                          | `FAILED`     | `null` — see below                                          |

If you are extending this pipeline and are tempted to give hard-ignored paths a row "for
completeness," or to silently drop a `.gitattributes` match instead of recording it —
don't; both look like reasonable cleanups and both break the database-verification
invariant every later phase relies on (see "Counters" below).

**A `FAILED` row's `contentHash` is a documented placeholder** — `sha256` of the empty
buffer, since the file couldn't be read and the column is `NOT NULL`. `indexState=FAILED`
is the actual signal that this hash is not meaningful; a consumer must check it before
comparing hashes for equality. **Phase 14 (incremental indexing) must special-case
`FAILED` rows** — comparing this placeholder hash for equality would otherwise treat a
`FAILED` row and a genuinely empty file as "unchanged."

## Content hash — a contract, not a default

`contentHash` is `sha256` of the file's **raw bytes exactly as extracted**, with no
line-ending or BOM normalization (`walk-tree.ts`). `git archive` — what produces the
tarball this pipeline reads — already normalizes line endings per the repository's own
`.gitattributes` `text`/`eol` settings before this code ever sees a byte; re-normalizing
here would risk silently disagreeing with what a contributor's own `git show` of the same
blob produces. This makes the hash stable across repeated indexes of the same commit, and
is the promise Phase 05's embedding-cache key and Phase 14's incremental-indexing key
both rely on — **provided they hash their own inputs the same way** (raw bytes, no
normalization). This is stated here as an explicit, checkable contract for exactly that
reason.

## Counters — binding definitions, because reconciliation depends on them being exact

`RepositoryFile` rows a completed walk produces fall into three buckets, defined in
`index-job.repository.ts`'s own header comment and applied in `indexer.service.ts`'s
`countByBucket`:

- **`filesTotal`** = `INDEXED + SKIPPED + FAILED`. **Never** includes hard-ignored paths
  (they get no row — see above).
- **`filesProcessed`** = `INDEXED + FAILED` — every file the pipeline actually finished
  attempting, whether the attempt succeeded or not. "Processed" means "attempted to
  completion," not "succeeded."
- **`filesSkipped`** = `SKIPPED` (any reason) — files deliberately excluded by _policy_,
  never attempted for indexing purposes.

By construction, `filesProcessed + filesSkipped === filesTotal` always holds for a
completed walk — this is the reconciliation invariant §14 (Database Verification) checks,
made true by definition rather than merely asserted after the fact.

## Caps — where they're configured

| Cap                                      | Default                       | Env var                                          | Enforced in                                                                                                                                                   |
| ---------------------------------------- | ----------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Total extracted bytes per repository     | 2 GiB                         | `INDEX_MAX_TOTAL_BYTES`                          | `archive-extractor.ts` — a counting `Transform` between `gunzip` and the tar parser, observing the _decompressed_ running total, not the compressed wire size |
| Total file count per repository          | 200,000                       | `INDEX_MAX_FILE_COUNT`                           | `archive-extractor.ts`                                                                                                                                        |
| Per-file size (indexing, not extraction) | 512 KB                        | `SIZE_CAP_BYTES` (code constant, not an env var) | `file-classifier.ts`                                                                                                                                          |
| Per-entry sanity cap during extraction   | same as the total byte budget | — (not separately configurable)                  | `archive-extractor.ts` — a single archive entry's _declared_ size alone exceeding the total budget is rejected before any of its bytes are read               |

Exceeding either extraction-level cap aborts the whole job cleanly
(`indexError.code=REPO_TOO_LARGE`), rather than partially indexing a repository past the
point where the caps exist to protect worker disk/memory.

## Repository health note

If hard-ignore removes more than half of a repository's paths (and there were more than
100 to begin with — small repositories don't trip this), `walk-tree.ts` logs a distinct
`logger.warn("repository health note: ...")` line, separate from the ordinary per-run
completion log, so this case is discoverable without parsing every run's aggregate
counts. This is the committed-`node_modules` case (`plan.md` §43.2) — real, and worth a
signal rather than silent absorption, even though the pipeline handles it correctly
either way.

## Observability

Every step of `repository-index` logs `component: "indexing.repository-index"` plus
`repositoryId`, and — once step 1 has created the row — `jobId`/`indexJobId`,
`currentStep`, and outcome counts; step timing is visible from consecutive log lines'
timestamps rather than a separately-computed duration field. Skip reasons are logged in
**aggregate** (a count per `skipReason`) once, at job completion — never per file, which
would be a real cost on a 200,000-file repository. See `apps/worker/src/indexing/walk-tree.ts`'s
own completion log line for the exact shape.

## Where the code lives

```
apps/worker/src/indexing/
  fetcher/tarball-fetcher.ts       streamed download, redirect-host pinned to codeload.github.com
  fetcher/archive-extractor.ts     path-traversal-safe extraction, the two extraction-level caps
  filter/ignore-rules.ts           hard-ignore globs, .gitattributes generated/vendored (stages 1–2)
  filter/file-classifier.ts        size/binary/minified (stages 3–5), classification, language, isTest/isGenerated
  walk-tree.ts                     composes the filter stages + hashing over an extracted tree
  persistence/repository-file.repository.ts   batched upsert (1,000 rows/statement) + stale-row sweep
  persistence/index-job.repository.ts         IndexJob lifecycle and progress writes
  persistence/repository.repository.ts        the lock, SHA resolution, terminal Repository writes
  indexer.service.ts               the Inngest-agnostic fetch→extract→walk→persist seam
apps/worker/src/inngest/functions/repository-index.ts   the Inngest function wrapping all of the above
```
