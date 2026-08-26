import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { createLogger, type Logger } from "@repo/observability";
import * as tarStream from "tar-stream";

/**
 * Materializes a repository tarball into a safe file tree in a per-job temp directory.
 *
 * **The archive is hostile by default.** Repository content is attacker-controlled in
 * the general case (public repos, forks, contributors) — this is the single highest-risk
 * module in Phase 03 (§13), and every design choice below is a response to a specific
 * attack, not a style preference.
 *
 * ## Library choice: tar-stream, not tar-fs or node-tar
 *
 * Read before deciding, not assumed (all three are already in the lockfile transitively,
 * via Testcontainers — see docs/decisions/phase-03-log.md for what was read where):
 *
 * - **tar-fs** (`node_modules/.pnpm/tar-fs@3.1.3` and `2.1.5`) extracts *to the
 *   filesystem itself* — it calls `fs.symlink`/`fs.link`/`fs.mkdir`/`fs.writeFile`
 *   directly from inside the library, before this module's code ever sees an entry. It
 *   does ship an `ignore`/filter option and its own path-safety checks, but "a library's
 *   own safe-extract flag is not evidence" is the literal instruction here — trusting a
 *   dependency's internal path-joining to be correct is exactly the kind of claim this
 *   phase exists to *not* take on faith, for code whose entire job is defending against
 *   path traversal.
 * - **tar** (node-tar, `node_modules/.pnpm/tar@7.5.22`) is the same shape: a complete,
 *   opinionated extractor with its own (real, but again unverified-by-us) symlink and
 *   path-escape defenses baked in, and no seam to inspect a header *before* it acts.
 * - **tar-stream** (`node_modules/.pnpm/tar-stream@3.2.0`) is, per its own README,
 *   "a streaming tar parser and generator and nothing else" — `extract()` emits
 *   `(header, entryStream, callback)` per entry and **performs zero filesystem writes on
 *   its own**. Every write in this file is this module's own `fs` call, over a path this
 *   module itself validated. That is what "per-entry inspection before any write" means
 *   literally, not as a library's internal promise. Confirmed by reading
 *   `tar-stream@3.2.0`'s `extract.js`: entries are surfaced from `headers.decode()`
 *   output with no `fs` import anywhere in the package.
 *
 * ## Symlinks and hardlinks: rejected, not aborted
 *
 * GitHub tarballs of legitimate repositories do contain symlinks (§13's own risk note).
 * Aborting the whole index on every symlink would fail real repositories, so a `symlink`
 * or `link` (hardlink) entry is **skipped and recorded**, not written, and extraction
 * continues. This is not a partial mitigation: because the symlink itself is never
 * created on disk, the classic follow-on attack — write a symlink named `foo` pointing
 * outside the root, then a later entry named `foo/passwd` that the OS resolves *through*
 * the symlink on write — cannot occur here. `fs.mkdir(..., { recursive: true })` for a
 * later `foo/passwd` entry simply creates `foo` as an ordinary directory, because `foo`
 * never existed as anything else.
 *
 * ## Path traversal and absolute paths: abort the whole archive
 *
 * `git archive` (which produces GitHub's tarball) never legitimately emits a `../` entry
 * or an absolute path — encountering one is proof of tampering, not an edge case to
 * accommodate. Unlike symlinks, this aborts extraction entirely (`UNSAFE_ARCHIVE`):
 * continuing to trust the *rest* of an archive that has already lied about one entry's
 * path is not a risk worth taking for an operation that runs unattended in the
 * background.
 *
 * ## The zip-bomb defense is a byte-counting Transform, not a per-file check
 *
 * A tiny, highly-compressed `.tar.gz` can decompress to gigabytes. The cap is enforced
 * on the *decompressed* byte stream, between gunzip and the tar parser, so it catches
 * both a single enormous entry and many small ones — and it counts bytes whether the
 * entry is ultimately written or skipped, because decompressing and parsing those bytes
 * costs CPU/memory either way.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ArchiveExtractorErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
}

export abstract class ArchiveExtractorError extends Error {
  abstract readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(message: string, options: ArchiveExtractorErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.details = options.details ?? {};
  }
}

/** A hostile entry was found: path traversal, an absolute/drive-letter path, or a path
 * that otherwise resolves outside the extraction root. Attack details are logged in
 * full but never included in `.message` — §12 requires the UI-facing failure to be
 * generic ("do not surface attack details to the UI"), and `.message` is the field a
 * caller is most likely to let reach a response body. */
export class UnsafeArchiveError extends ArchiveExtractorError {
  readonly code = "UNSAFE_ARCHIVE";
}

/** Cumulative extracted bytes or entry count exceeded the configured cap. */
export class ArchiveTooLargeError extends ArchiveExtractorError {
  readonly code = "REPO_TOO_LARGE";
}

// ---------------------------------------------------------------------------
// Extraction-time skip bookkeeping — distinct from RepositoryFile.skipReason
// ---------------------------------------------------------------------------

/**
 * Why the extractor itself declined to write an entry to disk. Deliberately a *separate*
 * vocabulary from `@repo/shared`'s `SkipReason` (`SKIPPED_TOO_LARGE`, `SKIPPED_GENERATED`,
 * …): those describe Prompt 2's *filter pipeline* deciding a successfully-extracted file
 * shouldn't be indexed. These describe this module declining to extract an entry at all —
 * a different layer, running before any filtering logic exists.
 */
export const EXTRACTION_SKIP_REASONS = [
  "SYMLINK",
  "HARDLINK",
  "UNSUPPORTED_ENTRY_TYPE",
  "INVALID_FILENAME",
  "NO_TOP_LEVEL_PREFIX",
] as const;
export type ExtractionSkipReason = (typeof EXTRACTION_SKIP_REASONS)[number];

export interface ExtractionSkip {
  /** The entry's path as GitHub sent it, top-level component included — deliberately
   * *not* run through the same normalization as accepted paths, since the point is to
   * record what was rejected and why. */
  rawPath: string;
  reason: ExtractionSkipReason;
}

export interface ExtractionSummary {
  filesWritten: number;
  directoriesWritten: number;
  totalBytes: number;
  skipped: ExtractionSkip[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ArchiveExtractorOptions {
  /** Base scratch directory (WORKER_TEMP_DIR, resolved by the caller). */
  tempRootDir: string;
  /** Included in the per-job subdirectory name; must itself be filesystem-safe (an
   * IndexJob id is a uuid, which is). Not re-validated here — the caller owns it. */
  jobId: string;
  maxTotalBytes: number;
  maxFileCount: number;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Path and filename validation
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- detecting control characters is the point
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
// Case-insensitive; matches with or without an extension (CON, con.txt, ...).
const WINDOWS_RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.[^/]*)?$/i;

/**
 * Filename *hygiene* only — NUL/control characters, Windows-reserved names, empty
 * segments. Deliberately does **not** reject `.`/`..` segments: that traversal check
 * belongs to {@link resolveSafePath} alone, which resolves the *whole* path and
 * classifies an escape as `UNSAFE_ARCHIVE` (abort everything). A first version of this
 * function also rejected `..` here, which meant a traversal entry hit this hygiene check
 * *before* resolveSafePath ever ran and was silently skipped as an "invalid filename"
 * instead of aborting the archive — caught by this module's own test suite
 * (docs/decisions/phase-03-log.md), not by inspection. Two checks for the same condition
 * with two different consequences is worse than one check with the right consequence.
 */
function isValidPathSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (CONTROL_CHARS.test(segment)) return false;
  if (WINDOWS_RESERVED_NAME.test(segment)) return false;
  return true;
}

/** Every segment must pass {@link isValidPathSegment}; allows any non-ASCII Unicode
 * (§13's own `^[\w\-./ ]+$` example is ASCII-only and would reject legitimate
 * non-English filenames that exist in real repositories — see docs/decisions/phase-03-log.md
 * for why a segment-wise check was used instead of that regex verbatim). */
function isValidRelativePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.length > 0 && segments.every(isValidPathSegment);
}

/**
 * Resolves `relativePath` against `root` and confirms the result cannot escape it.
 *
 * Uses `path.relative(root, resolved)` rather than a `resolved.startsWith(root)` prefix
 * check — a prefix check is fooled by a sibling directory whose name extends the root's
 * (`/tmp/job1` vs `/tmp/job10`): `"/tmp/job10/x".startsWith("/tmp/job1")` is `true` as a
 * raw string comparison despite `job10` not being inside `job1` at all.
 * `path.relative()` computes the actual directory relationship instead, and an escape
 * shows up unambiguously as a result starting with `..` (or, on a path.relative case
 * that resolves to a different root entirely, as an absolute path).
 */
/** Exported for direct unit testing of the sibling-prefix defeat (§14/§15) — see
 * archive-extractor.test.ts. Not part of the module's intended public API otherwise. */
export function resolveSafePath(root: string, relativePath: string): string | null {
  const resolved = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, resolved);
  if (relativeToRoot === "") return null; // resolves to the root itself, not a file
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) return null;
  return resolved;
}

/**
 * Strips the tarball's single top-level directory (`{owner}-{repo}-{shortsha}/`) so
 * stored paths are repository-relative. Every downstream phase's path matching depends
 * on this (PR diffs, context retrieval, comment positioning) — done here, once.
 *
 * Entries with no `/` at all never occur in a well-formed `git archive` output (every
 * entry, including the top-level directory itself, has at least one `/` once you count
 * the directory entry's own trailing slash) — treated as `NO_TOP_LEVEL_PREFIX` rather
 * than guessed at, since accepting one would place a file at an unpredictable location
 * relative to every other extracted path.
 */
function stripTopLevelComponent(entryName: string): string | null {
  const normalized = entryName.startsWith("./") ? entryName.slice(2) : entryName;
  const firstSlash = normalized.indexOf("/");
  if (firstSlash === -1) return null;
  return normalized.slice(firstSlash + 1);
}

// ---------------------------------------------------------------------------
// The byte-counting cap — the actual zip-bomb defense
// ---------------------------------------------------------------------------

function createByteCounter(maxTotalBytes: number, onBytes: (cumulative: number) => void): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      if (total > maxTotalBytes) {
        callback(new ArchiveTooLargeError(`extraction exceeded the ${maxTotalBytes.toString()}-byte cap`, { details: { maxTotalBytes } }));
        return;
      }
      onBytes(total);
      callback(null, chunk);
    },
  });
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

async function writeEntry(entryStream: tarStream.Entry, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const handle = await fs.open(destination, "w");
  try {
    await pipeline(entryStream, handle.createWriteStream());
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function drainEntry(entryStream: tarStream.Entry): Promise<void> {
  // Auto-drain without writing anywhere — tar-stream's own recommended pattern for
  // skipping an entry (README: "stream.resume() // just auto drain the stream"). The
  // bytes still pass through the byte-counting Transform upstream, so they still count
  // against the cap even though nothing is written to disk.
  await new Promise<void>((resolve, reject) => {
    entryStream.on("error", reject);
    entryStream.on("end", resolve);
    entryStream.resume();
  });
}

/**
 * Extracts `gzippedTarball` into a fresh, job-unique directory under
 * `options.tempRootDir`, then invokes `onExtracted(rootDir, summary)` with that
 * directory's path. The directory — and everything written into it — is removed in a
 * `finally` that runs on every path out of this function: extraction failure,
 * `onExtracted` throwing, or `onExtracted` succeeding (plan.md §35.10). Callers that
 * need the extracted files do all of that work *inside* `onExtracted`; nothing about the
 * directory is guaranteed to exist once this function's returned promise settles.
 */
export async function extractRepositoryArchive<T>(
  gzippedTarball: ReadableStream<Uint8Array>,
  options: ArchiveExtractorOptions,
  onExtracted: (rootDir: string, summary: ExtractionSummary) => Promise<T>,
): Promise<T> {
  const logger = options.logger ?? createLogger("indexing.archive-extractor");
  const jobDir = path.join(options.tempRootDir, `repo-index-${options.jobId}-${randomUUID()}`);
  await fs.mkdir(jobDir, { recursive: true });

  try {
    const summary = await runExtraction(gzippedTarball, jobDir, options, logger);
    logger.info("archive extraction completed", {
      jobId: options.jobId,
      filesWritten: summary.filesWritten,
      directoriesWritten: summary.directoriesWritten,
      totalBytes: summary.totalBytes,
      skippedCount: summary.skipped.length,
      // Aggregate counts only (§20: skip reasons logged in aggregate, not per-file).
      skippedByReason: countByReason(summary.skipped),
    });
    return await onExtracted(jobDir, summary);
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch((error: unknown) => {
      logger.warn("failed to remove extraction temp directory", {
        jobId: options.jobId,
        jobDir,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

function countByReason(skipped: ExtractionSkip[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of skipped) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  return counts;
}

async function runExtraction(
  gzippedTarball: ReadableStream<Uint8Array>,
  jobDir: string,
  options: ArchiveExtractorOptions,
  logger: Logger,
): Promise<ExtractionSummary> {
  const gunzip = createGunzip();
  const extract = tarStream.extract();
  let cumulativeBytes = 0;
  const byteCounter = createByteCounter(options.maxTotalBytes, (total) => {
    cumulativeBytes = total;
  });

  // Not awaited here — tar-stream's Extract is simultaneously the pipeline's writable
  // destination and the async-iterable this function consumes below; both run
  // concurrently, matching tar-stream's own documented usage. Awaited after the loop so
  // a late pipeline error (a corrupt gzip trailer, the byte cap tripping on the final
  // chunk) still surfaces even if every entry looked fine up to that point.
  //
  // The cast is required because `Readable.fromWeb` types its parameter against
  // `node:stream/web`'s `ReadableStream`, not the DOM-lib global of the same name that
  // `fetch()`'s `Response.body` (and this function's own signature) use — two nominally
  // distinct declarations of the same runtime type. Both describe a real WHATWG
  // ReadableStream; only the TypeScript declarations disagree.
  const webStream = gzippedTarball as unknown as import("node:stream/web").ReadableStream<Uint8Array>;
  const pipelineDone = pipeline(Readable.fromWeb(webStream), gunzip, byteCounter, extract).catch((error: unknown) => {
    // Re-thrown (not swallowed) below via `await pipelineDone` — caught here only so an
    // unhandled-rejection warning cannot fire before this function has a chance to await it.
    return error instanceof Error ? error : new Error(String(error));
  });

  let filesWritten = 0;
  let directoriesWritten = 0;
  let entryCount = 0;
  const skipped: ExtractionSkip[] = [];

  try {
    for await (const entryStream of extract) {
      entryCount += 1;
      const header = entryStream.header;
      const declaredSize = header.size ?? 0;

      if (entryCount > options.maxFileCount) {
        entryStream.destroy();
        throw new ArchiveTooLargeError(`extraction exceeded the ${options.maxFileCount.toString()}-file cap`, {
          details: { maxFileCount: options.maxFileCount },
        });
      }

      // A per-entry sanity cap: no single entry may, alone, exceed the whole job's byte
      // budget. Rejected before a single byte of it is read — the running byte counter
      // below is the defense against many entries summing past the cap; this is the
      // defense against one entry lying about being reasonable.
      if (declaredSize > options.maxTotalBytes) {
        entryStream.destroy();
        throw new ArchiveTooLargeError(`a single entry (${header.name}) exceeds the ${options.maxTotalBytes.toString()}-byte cap`, {
          details: { entryPath: header.name, entrySize: declaredSize, maxTotalBytes: options.maxTotalBytes },
        });
      }

      // Checked against the RAW entry name, before top-level-stripping — an absolute
      // path's leading `/` would otherwise be misread as the top-level-directory
      // boundary `stripTopLevelComponent` strips, silently turning `/etc/passwd` into
      // the seemingly-safe relative path `etc/passwd`. Same treatment as path
      // traversal: git archive never emits one, so finding one aborts the whole archive.
      if (path.isAbsolute(header.name) || /^[a-zA-Z]:/.test(header.name)) {
        entryStream.destroy();
        logger.warn("rejected an archive entry with an absolute or drive-letter path", {
          jobId: options.jobId,
          entryPath: header.name,
        });
        throw new UnsafeArchiveError("the archive contains an entry with an unsafe path", {
          details: { jobId: options.jobId },
        });
      }

      const relativePath = stripTopLevelComponent(header.name);
      if (relativePath === null) {
        await drainEntry(entryStream);
        skipped.push({ rawPath: header.name, reason: "NO_TOP_LEVEL_PREFIX" });
        continue;
      }
      if (relativePath === "") {
        // The top-level directory entry itself — nothing to create, jobDir already is it.
        await drainEntry(entryStream);
        continue;
      }

      if (header.type === "symlink" || header.type === "link") {
        await drainEntry(entryStream);
        skipped.push({ rawPath: header.name, reason: header.type === "symlink" ? "SYMLINK" : "HARDLINK" });
        logger.debug("skipped archive entry — symlink/hardlink never created", { jobId: options.jobId, entryType: header.type });
        continue;
      }

      if (header.type !== "file" && header.type !== "directory") {
        await drainEntry(entryStream);
        skipped.push({ rawPath: header.name, reason: "UNSUPPORTED_ENTRY_TYPE" });
        continue;
      }

      if (!isValidRelativePath(relativePath)) {
        await drainEntry(entryStream);
        skipped.push({ rawPath: header.name, reason: "INVALID_FILENAME" });
        continue;
      }

      const destination = resolveSafePath(jobDir, relativePath);
      if (destination === null) {
        entryStream.destroy();
        // Full attack details go to the log; the thrown message is deliberately generic
        // (§12: never surface attack details to the UI).
        logger.warn("rejected an archive entry whose path escapes the extraction root", {
          jobId: options.jobId,
          entryPath: header.name,
        });
        throw new UnsafeArchiveError("the archive contains an entry with an unsafe path", {
          details: { jobId: options.jobId },
        });
      }

      if (header.type === "directory") {
        await fs.mkdir(destination, { recursive: true });
        await drainEntry(entryStream);
        directoriesWritten += 1;
        continue;
      }

      await writeEntry(entryStream, destination);
      filesWritten += 1;
    }

    const pipelineError = await pipelineDone;
    if (pipelineError) throw pipelineError;
  } catch (error) {
    extract.destroy();
    gunzip.destroy();
    throw error;
  }

  return { filesWritten, directoriesWritten, totalBytes: cumulativeBytes, skipped };
}
