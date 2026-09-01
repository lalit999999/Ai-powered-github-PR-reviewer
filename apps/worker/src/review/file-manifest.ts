import type { FileClassification, PullRequestFileStatus, ReviewDepth } from "@repo/shared";
import { MAX_DEEP_FILES, MAX_FILES_CONSIDERED, OVERSIZED_FILE_DIFF_LINES } from "@repo/shared";
import { classifyChangedFile, decideReviewDepth } from "../indexing/filter/file-classifier.js";
import { countChangedLines, parsePatch } from "../retrieval/patch-parser.js";
import { buildDiffPositionMap, type DiffPositionMap } from "../retrieval/diff-position-map.js";
import { buildPriorityContext, computePriorityScore, type PriorityInput } from "./priority-score.js";

/**
 * Manifest assembly — `plan.md` §44's `review/file-manifest.ts`, Prompt 3 of
 * phase-07-pr-ingestion.md sub-task 3.5. Pure: no I/O, no Prisma. This is where the
 * whole-PR decisions live — scoring every file, sorting them, and applying the two hard
 * caps — as opposed to `file-classifier.ts`'s `decideReviewDepth`, which is deliberately
 * per-file and knows nothing about the rest of the PR.
 *
 * **This function is where Prompt 4's Inngest fan-out order comes from.** Any change to
 * the sort below changes which files get reviewed first, and therefore which files get
 * demoted when `MAX_DEEP_FILES`/`MAX_FILES_CONSIDERED` bind on a large PR — treat a
 * change to the sort comparator as a change to review outcomes, not a cosmetic reorder.
 */

export interface ManifestFileInput {
  path: string;
  previousPath: string | null;
  status: PullRequestFileStatus;
  additions: number;
  deletions: number;
  patch: string | null;
  /** Phase 04 signals for this path, already looked up by the caller. */
  inboundEdgeCount: number;
  exportsPublicApi: boolean;
  noTestLinked: boolean;
}

export interface ManifestFile {
  path: string;
  previousPath: string | null;
  status: PullRequestFileStatus;
  classification: FileClassification;
  reviewDepth: ReviewDepth;
  additions: number;
  deletions: number;
  priorityScore: number;
  diffPositionMap: DiffPositionMap;
  changedLines: number;
  /** True when `changedLines > OVERSIZED_FILE_DIFF_LINES`. Detection only in this phase —
   * hunk-cluster splitting is Phase 08's job (spec §3 Out of Scope). Recorded here so
   * Phase 08 does not have to re-derive it. */
  oversized: boolean;
  /** The raw patch, still unstored. Prompt 4 passes this to the patch store; this module
   * does no I/O of its own. */
  patch: string | null;
}

export interface Manifest {
  /** Sorted by `priorityScore` descending, tie-broken by `path` ascending. */
  files: ManifestFile[];
  deepFileCount: number;
  shallowFileCount: number;
  skippedFileCount: number;
  /** True when the caller told us GitHub's 3,000-file cap was hit, OR when more than
   * `MAX_FILES_CONSIDERED` files were present. Both mean "the review does not cover
   * everything", which is the single fact `Review.truncated` records. */
  truncated: boolean;
}

interface FileWork {
  input: ManifestFileInput;
  classification: FileClassification;
  diffPositionMap: DiffPositionMap;
  changedLines: number;
  oversized: boolean;
  reviewDepth: ReviewDepth;
  priorityScore: number;
}

/**
 * The algorithm, in this exact order:
 *
 * 1. For every file: `parsePatch(patch)` -> `buildDiffPositionMap(parsed)` ->
 *    `countChangedLines(parsed)` -> `classifyChangedFile(path)` -> `decideReviewDepth`.
 *    One parse per file, reused three ways — `plan.md` §15.3's "one parser in the system"
 *    rule.
 * 2. `buildPriorityContext(...)` over the whole set, then `computePriorityScore` per file.
 * 3. Sort by `priorityScore` descending, tie-broken by `path` ascending. The tiebreak is
 *    not cosmetic — without it the order depends on GitHub's own response order, and two
 *    runs of the same review would produce different cap decisions. Determinism here is
 *    what makes the caps below testable and the review reproducible.
 * 4. Cap 1 — files considered (`MAX_FILES_CONSIDERED`). Every file at index >= the cap is
 *    forced to `reviewDepth: "SKIP"`. It still gets a row — `plan.md` §16.4 says "rest
 *    listed but not reviewed" — never dropped.
 * 5. Cap 2 — deep files (`MAX_DEEP_FILES`). Walking the (already sorted) first
 *    `MAX_FILES_CONSIDERED`, once that many `DEEP` files have been counted, every further
 *    `DEEP` file demotes to `SHALLOW` — never to `SKIP` (spec §3: DEEP-eligible overflow
 *    falls back to SHALLOW, a huge PR still gets a lighter pass on every file).
 * 6. Recount `deepFileCount`/`shallowFileCount`/`skippedFileCount` AFTER both caps, so the
 *    counts describe what will actually happen, not what was merely eligible.
 * 7. `truncated = options.githubTruncated || files.length > MAX_FILES_CONSIDERED`.
 */
export function buildManifest(
  files: readonly ManifestFileInput[],
  options: { githubTruncated: boolean },
): Manifest {
  const work: FileWork[] = files.map((input) => {
    const parsed = parsePatch(input.patch);
    const diffPositionMap = buildDiffPositionMap(parsed);
    const changedLines = countChangedLines(parsed);
    const classification = classifyChangedFile(input.path);
    const reviewDepth = decideReviewDepth({
      classification,
      status: input.status,
      additions: input.additions,
      deletions: input.deletions,
      hasPatch: input.patch !== null,
      changedLines,
    });
    return {
      input,
      classification,
      diffPositionMap,
      changedLines,
      oversized: changedLines > OVERSIZED_FILE_DIFF_LINES,
      reviewDepth,
      priorityScore: 0, // filled in below, once the whole-set PriorityContext exists
    };
  });

  const priorityInputs: PriorityInput[] = work.map((f) => ({
    path: f.input.path,
    classification: f.classification,
    additions: f.input.additions,
    deletions: f.input.deletions,
    inboundEdgeCount: f.input.inboundEdgeCount,
    exportsPublicApi: f.input.exportsPublicApi,
    noTestLinked: f.input.noTestLinked,
  }));
  const priorityContext = buildPriorityContext(priorityInputs);
  work.forEach((f, i) => {
    f.priorityScore = computePriorityScore(priorityInputs[i]!, priorityContext);
  });

  const sorted = work.slice().sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    if (a.input.path < b.input.path) return -1;
    if (a.input.path > b.input.path) return 1;
    return 0;
  });

  // Cap 1 — files considered.
  const depths = sorted.map((f, idx) => (idx >= MAX_FILES_CONSIDERED ? "SKIP" : f.reviewDepth));

  // Cap 2 — deep files, walked over the (already-capped) considered window only.
  let deepSeen = 0;
  for (let idx = 0; idx < depths.length && idx < MAX_FILES_CONSIDERED; idx += 1) {
    if (depths[idx] === "DEEP") {
      deepSeen += 1;
      if (deepSeen > MAX_DEEP_FILES) depths[idx] = "SHALLOW";
    }
  }

  const manifestFiles: ManifestFile[] = sorted.map((f, idx) => ({
    path: f.input.path,
    previousPath: f.input.previousPath,
    status: f.input.status,
    classification: f.classification,
    reviewDepth: depths[idx]!,
    additions: f.input.additions,
    deletions: f.input.deletions,
    priorityScore: f.priorityScore,
    diffPositionMap: f.diffPositionMap,
    changedLines: f.changedLines,
    oversized: f.oversized,
    patch: f.input.patch,
  }));

  let deepFileCount = 0;
  let shallowFileCount = 0;
  let skippedFileCount = 0;
  for (const file of manifestFiles) {
    if (file.reviewDepth === "DEEP") deepFileCount += 1;
    else if (file.reviewDepth === "SHALLOW") shallowFileCount += 1;
    else skippedFileCount += 1;
  }

  return {
    files: manifestFiles,
    deepFileCount,
    shallowFileCount,
    skippedFileCount,
    truncated: options.githubTruncated || files.length > MAX_FILES_CONSIDERED,
  };
}
