import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { FileClassification, IndexState, SkipReason } from "@repo/shared";
import { createLogger, type Logger } from "@repo/observability";
import {
  classify,
  classifyFile,
  countLines,
  detectIsGenerated,
  detectIsTest,
  detectLanguage,
  detectPackageName,
  SIZE_CAP_BYTES,
} from "./filter/file-classifier.js";
import {
  classifyIgnore,
  isHardIgnored,
  isHardIgnoredDirectory,
  parseGitattributes,
  type GitattributesRule,
} from "./filter/ignore-rules.js";

/**
 * `plan.md` §8.2 steps 4–5: walk the extracted tree, apply {@link classifyIgnore}
 * (ignore-rules.ts) then the classifier (file-classifier.ts), and `sha256` every
 * surviving file's content. Runs entirely against `rootDir` — the directory
 * `archive-extractor.ts`'s `onExtracted` callback hands the caller, already
 * repository-relative and already safe to read without further path validation (every
 * entry that reached disk already passed `resolveSafePath`).
 *
 * This module does **not** persist anything (2.4/repository-file.repository.ts's job) and
 * knows nothing about Inngest steps (indexer.service.ts/repository-index.ts's job) — it
 * is a pure(ish) filesystem-in, structured-data-out function, which is what makes it
 * unit-testable against a real temp directory without any of those other seams.
 *
 * ## Content hash — raw bytes, no normalization, documented because Phase 05 must rely on it
 *
 * `contentHash` is `sha256` of the file's **raw bytes exactly as extracted**, computed
 * with no line-ending or BOM normalization. This is a deliberate default, not an
 * oversight: `git archive` (what produced this tree) already normalizes line endings
 * according to the repository's own `.gitattributes` `text`/`eol` settings *before*
 * this code ever sees the bytes, so re-normalizing here would risk silently disagreeing
 * with what a contributor's own `git show` of the same blob produces. The hash is
 * therefore stable across repeated indexes of the same commit and is safe to use as
 * Phase 14's incremental-indexing key and Phase 05's embedding-cache key, exactly as
 * `RepositoryFile.contentHash`'s column comment promises — provided both of those
 * phases hash their own inputs the same way (raw bytes, no normalization), which this
 * comment exists to make an explicit, checkable contract rather than an assumption.
 */

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface WalkedFile {
  path: string;
  contentHash: string;
  sizeBytes: number;
  lineCount: number;
  packageName: string | null;
  classification: FileClassification;
  language: string | null;
  indexState: IndexState;
  skipReason: SkipReason | null;
  isTest: boolean;
  isGenerated: boolean;
}

/**
 * §16/§21/§22: a health signal for the committed-`node_modules` case, computed from the
 * walk itself rather than a follow-up query. `hardIgnoredCount` never gets a
 * `RepositoryFile` row (ignore-rules.ts's own contract), so this is the *only* place
 * that number is ever known — once the walk returns, it is gone unless captured here.
 */
export interface WalkSummary {
  files: WalkedFile[];
  /** Every path considered at all, including hard-ignored ones — the denominator for
   * `hardIgnoreRatio` below. Not the same as `IndexJob.filesTotal` (see
   * indexer.service.ts / index-job.repository.ts for that definition, which
   * deliberately excludes hard-ignored paths so the reconciliation invariant in §14
   * holds). */
  pathsConsidered: number;
  hardIgnoredCount: number;
  /** `hardIgnoredCount / pathsConsidered`, or `0` when nothing was considered at all. */
  hardIgnoreRatio: number;
  /** Aggregate counts per `SkipReason`, logged once at job completion rather than per
   * file (§20) — this is the structure that log line is built from. */
  skippedByReason: Partial<Record<SkipReason, number>>;
  failedCount: number;
}

export interface WalkTreeOptions {
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** `sha256` of an already-in-memory buffer — used for every file small enough to have
 * been read in full for classification anyway, so hashing costs no extra I/O. */
function hashBuffer(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * `sha256` computed by streaming the file from disk, never buffering it whole — used
 * only for files over {@link SIZE_CAP_BYTES} that classification never reads into
 * memory (§4: "never load the whole tree into memory"). Event-based (`.on("data", ...)`
 * over `.pipe(hash)`) deliberately: `crypto.Hash` is a `Transform` stream, and piping a
 * large read stream into one without ever consuming its *readable* side risks the
 * classic unconsumed-Transform stall under backpressure. Reading and calling
 * `hash.update()` per chunk has no such risk.
 */
async function hashFileStreaming(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
    stream.on("error", reject);
  });
}

/** `sha256("")` — Node's own constant, computed once rather than hand-copied to avoid a
 * transcription error in a value nothing will ever visibly validate against. */
const EMPTY_CONTENT_HASH = createHash("sha256")
  .update(Buffer.alloc(0))
  .digest("hex");

// ---------------------------------------------------------------------------
// Directory walk — collects candidate paths, pruning hard-ignored subtrees whole
// ---------------------------------------------------------------------------

/**
 * Package roots for {@link detectPackageName}: the directory of every `package.json`
 * among the (already hard-ignore-filtered) candidate paths, so a `node_modules`-nested
 * `package.json` — there can be thousands in a committed-`node_modules` monorepo — never
 * pollutes this list, since `node_modules/**` is pruned before candidates are collected
 * at all. Sorted longest-path-first so {@link detectPackageName}'s linear scan finds
 * the nearest ancestor, not merely *an* ancestor.
 */
function derivePackageRoots(candidatePaths: readonly string[]): string[] {
  const roots = candidatePaths
    .filter((p) => path.basename(p) === "package.json")
    .map((p) => path.dirname(p));
  return [...new Set(roots)].sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// Per-file processing
// ---------------------------------------------------------------------------

/** Metadata-only classification — used for files whose content is never read in full
 * (an over-cap file, or a `.gitattributes`-skipped one): everything here is derived
 * from the path alone, which costs nothing regardless of the file's size. */
function classifyByPathOnly(
  relativePath: string,
  forcedIsGenerated: boolean | undefined,
): {
  language: string | null;
  isTest: boolean;
  isGenerated: boolean;
  classification: FileClassification;
} {
  const language = detectLanguage(relativePath);
  const isTest = detectIsTest(relativePath);
  const isGenerated = forcedIsGenerated ?? detectIsGenerated(relativePath);
  const classification = classifyFile(
    relativePath,
    isTest,
    isGenerated,
    language,
  );
  return { language, isTest, isGenerated, classification };
}

interface ProcessFileDeps {
  rootDir: string;
  gitattributesRules: readonly GitattributesRule[];
  packageRoots: readonly string[];
}

async function processFile(
  relativePath: string,
  deps: ProcessFileDeps,
  logger: Logger,
): Promise<WalkedFile> {
  const absolutePath = path.join(deps.rootDir, relativePath);
  const packageName = detectPackageName(relativePath, deps.packageRoots);

  try {
    const ignoreDecision = classifyIgnore(
      relativePath,
      deps.gitattributesRules,
    );

    if (ignoreDecision.kind === "HARD_IGNORE") {
      // Unreachable in practice: `collectAllPaths` already excludes every hard-ignored
      // file (both directory-pruned and file-pattern-matched) from `candidatePaths`
      // before `processFile` is ever called for it. A defensive throw here, rather than
      // silently falling through to the KEEP branch below, is deliberate — that silent
      // fallthrough is exactly the bug this comment exists to prevent from recurring
      // (see docs/decisions/phase-03-log.md: found via repository-fixtures.test.ts).
      throw new Error(
        `processFile reached for a hard-ignored path — collectAllPaths should have excluded it: ${relativePath}`,
      );
    }

    if (ignoreDecision.kind === "SKIP") {
      // A .gitattributes-declared generated/vendored file. The decision is already
      // made independent of size/content — stream-hash rather than buffer, since these
      // are exactly the files (vendored bundles, generated protobuf output) most likely
      // to be large, and there is nothing to gain from reading them into memory.
      const stat = await fs.stat(absolutePath);
      const contentHash = await hashFileStreaming(absolutePath);
      const meta = classifyByPathOnly(
        relativePath,
        ignoreDecision.reason === "SKIPPED_GENERATED",
      );

      return {
        path: relativePath,
        contentHash,
        sizeBytes: stat.size,
        lineCount: 0,
        packageName,
        classification: meta.classification,
        language: meta.language,
        indexState: "SKIPPED",
        skipReason: ignoreDecision.reason,
        isTest: meta.isTest,
        isGenerated: meta.isGenerated,
      };
    }

    // ignoreDecision.kind === "KEEP" — proceed to the size/binary/minified stages.
    const stat = await fs.stat(absolutePath);

    if (stat.size > SIZE_CAP_BYTES) {
      // Over the size cap — never buffered (§4). Still hashed, by streaming, so an
      // incremental re-index (Phase 14) can tell whether this row's content actually
      // changed; still classified by path alone, which is free.
      const contentHash = await hashFileStreaming(absolutePath);
      const meta = classifyByPathOnly(relativePath, undefined);

      return {
        path: relativePath,
        contentHash,
        sizeBytes: stat.size,
        lineCount: 0,
        packageName,
        classification: meta.classification,
        language: meta.language,
        indexState: "SKIPPED",
        skipReason: "SKIPPED_TOO_LARGE",
        isTest: meta.isTest,
        isGenerated: meta.isGenerated,
      };
    }

    // At or under the cap — one read serves classification, line counting, and
    // hashing, rather than three separate passes over the same bytes.
    const content = await fs.readFile(absolutePath);
    const decision = classify(
      relativePath,
      stat.size,
      content,
      deps.packageRoots,
    );
    const contentHash = hashBuffer(content);

    if (decision.skip) {
      return {
        path: relativePath,
        contentHash,
        sizeBytes: stat.size,
        // A binary file has no meaningful line count; a minified file's is cheap to
        // compute since the buffer is already in hand, and not actively misleading.
        lineCount:
          decision.reason === "SKIPPED_BINARY" ? 0 : countLines(content),
        packageName,
        classification: classifyByPathOnly(relativePath, undefined)
          .classification,
        language: detectLanguage(relativePath),
        indexState: "SKIPPED",
        skipReason: decision.reason,
        isTest: detectIsTest(relativePath),
        isGenerated: detectIsGenerated(relativePath),
      };
    }

    return {
      path: relativePath,
      contentHash,
      sizeBytes: stat.size,
      lineCount: countLines(content),
      packageName: decision.packageName,
      classification: decision.classification,
      language: decision.language,
      indexState: "INDEXED",
      skipReason: null,
      isTest: decision.isTest,
      isGenerated: decision.isGenerated,
    };
  } catch (error) {
    // §4/§12: one unreadable/corrupt file must never fail the whole walk. Best-effort
    // size (0 if even `stat` failed); a placeholder content hash rather than none, since
    // the column is NOT NULL — `indexState=FAILED` is the actual signal that this hash
    // is not meaningful and must never be compared for incremental-indexing purposes
    // (Phase 14's problem to special-case; flagged in docs/decisions/phase-03-log.md).
    logger.warn(
      "failed to read a file during the tree walk — marking it FAILED and continuing",
      {
        path: relativePath,
        error: error instanceof Error ? error.message : String(error),
      },
    );

    const sizeBytes = await fs
      .stat(absolutePath)
      .then((s) => s.size)
      .catch(() => 0);

    return {
      path: relativePath,
      contentHash: EMPTY_CONTENT_HASH,
      sizeBytes,
      lineCount: 0,
      packageName,
      classification: "UNKNOWN",
      language: null,
      indexState: "FAILED",
      skipReason: null,
      isTest: false,
      isGenerated: false,
    };
  }
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Reads `rootDir`'s own `.gitattributes` (only the root — see
 * docs/decisions/phase-03-log.md for why nested `.gitattributes` cascading is out of
 * scope this phase), walks the whole tree once to build the candidate path list and
 * package-root set, then processes every candidate. A single malformed file is caught
 * per-file inside {@link processFile}; nothing here can let one bad file abort the walk.
 */
export async function walkTree(
  rootDir: string,
  options: WalkTreeOptions = {},
): Promise<WalkSummary> {
  const logger = options.logger ?? createLogger("indexing.walk-tree");

  const gitattributesContent = await fs
    .readFile(path.join(rootDir, ".gitattributes"), "utf8")
    .catch(() => null);
  const gitattributesRules =
    gitattributesContent !== null
      ? parseGitattributes(gitattributesContent)
      : [];

  const allEntries = await collectAllPaths(rootDir);
  const candidatePaths = allEntries
    .filter((entry) => !entry.hardIgnored)
    .map((entry) => entry.path);
  const hardIgnoredCount = allEntries.length - candidatePaths.length;
  const packageRoots = derivePackageRoots(candidatePaths);

  const files: WalkedFile[] = [];
  const skippedByReason: Partial<Record<SkipReason, number>> = {};
  let failedCount = 0;

  for (const relativePath of candidatePaths) {
    const result = await processFile(
      relativePath,
      { rootDir, gitattributesRules, packageRoots },
      logger,
    );
    files.push(result);

    if (result.indexState === "SKIPPED" && result.skipReason) {
      skippedByReason[result.skipReason] =
        (skippedByReason[result.skipReason] ?? 0) + 1;
    }
    if (result.indexState === "FAILED") failedCount += 1;
  }

  const pathsConsidered = allEntries.length;
  const summary: WalkSummary = {
    files,
    pathsConsidered,
    hardIgnoredCount,
    hardIgnoreRatio:
      pathsConsidered === 0 ? 0 : hardIgnoredCount / pathsConsidered,
    skippedByReason,
    failedCount,
  };

  logger.info("tree walk completed", {
    pathsConsidered: summary.pathsConsidered,
    hardIgnoredCount: summary.hardIgnoredCount,
    hardIgnoreRatio: Number(summary.hardIgnoreRatio.toFixed(3)),
    indexedCount: files.filter((f) => f.indexState === "INDEXED").length,
    skippedByReason: summary.skippedByReason,
    failedCount: summary.failedCount,
  });

  // §22: a hard-ignore ratio this high is the committed-node_modules signature —
  // surfaced as a distinct, greppable log line (a "repository health note"), not
  // silently absorbed into the ordinary completion line above.
  if (summary.hardIgnoreRatio > 0.5 && pathsConsidered > 100) {
    logger.warn(
      "repository health note: hard-ignore rules removed most of this repository's files",
      {
        pathsConsidered: summary.pathsConsidered,
        hardIgnoredCount: summary.hardIgnoredCount,
        hardIgnoreRatio: Number(summary.hardIgnoreRatio.toFixed(3)),
      },
    );
  }

  return summary;
}

interface CandidateEntry {
  path: string;
  hardIgnored: boolean;
}

/**
 * The single recursive walk this module performs, pruning hard-ignored subtrees whole
 * (see `isHardIgnoredDirectory`'s own doc comment) while still counting what was pruned,
 * for {@link WalkSummary.hardIgnoredCount}
 * — without this, pruning a whole `node_modules` directory in one step (the performance
 * win {@link isHardIgnoredDirectory} exists for) would make the health-note ratio blind
 * to the very case it exists to catch. Pruned subtrees are counted by a full (unpruned)
 * recursive stat pass **only when a prune actually occurs**, so the common case (a
 * repository with nothing to prune) pays no extra cost.
 */
async function collectAllPaths(rootDir: string): Promise<CandidateEntry[]> {
  const results: CandidateEntry[] = [];

  async function walk(absoluteDir: string, relativeDir: string): Promise<void> {
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath =
        relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;

      if (entry.isDirectory()) {
        if (isHardIgnoredDirectory(relativePath)) {
          await countPrunedFiles(path.join(absoluteDir, entry.name), results);
          continue;
        }
        await walk(path.join(absoluteDir, entry.name), relativePath);
        continue;
      }

      if (entry.isFile()) {
        // A directory-anchored pattern (node_modules/**, dist/**, ...) is pruned above,
        // before its files are ever listed here — but roughly half of
        // HARD_IGNORE_PATTERNS is filename/extension-anchored (lockfiles, **/*.min.js,
        // **/*.png, ...) and matches an individual file that is never inside a prunable
        // directory. Those must be checked per file, here, or they silently fall through
        // to KEEP with a real RepositoryFile row — exactly the "no row at all" contract
        // ignore-rules.ts's own header comment promises being violated. (Found by
        // repository-fixtures.test.ts, Prompt 3 — see docs/decisions/phase-03-log.md.)
        results.push({
          path: relativePath,
          hardIgnored: isHardIgnored(relativePath),
        });
      }
    }
  }

  await walk(rootDir, "");
  return results;
}

async function countPrunedFiles(
  absoluteDir: string,
  results: CandidateEntry[],
): Promise<void> {
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await countPrunedFiles(path.join(absoluteDir, entry.name), results);
    } else if (entry.isFile()) {
      // The path recorded for a pruned entry is never read again (only its count
      // matters for the health-note ratio), so it is not reconstructed relative to
      // rootDir here — a placeholder is cheaper and nothing downstream inspects it.
      results.push({ path: entry.name, hardIgnored: true });
    }
  }
}
