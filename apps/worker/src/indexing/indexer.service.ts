import { createLogger, type Logger } from "@repo/observability";
import { extractRepositoryArchive, type ExtractionSummary } from "./fetcher/archive-extractor.js";
import { fetchTarballStream, type TarballFetchOptions } from "./fetcher/tarball-fetcher.js";
import { sweepStaleRepositoryFiles, upsertRepositoryFiles, type RepositoryFileUpsertInput } from "./persistence/repository-file.repository.js";
import { walkTree, type WalkSummary } from "./walk-tree.js";

/**
 * The orchestration seam: fetch → extract → filter → classify → hash → persist
 * (`plan.md` §8.2 steps 3–6), composed as one plain async function with **no knowledge
 * of Inngest** — no `step.run`, no retries, no `NonRetriableError`, no `step.sleepUntil`.
 * Those stay in `repository-index.ts` (2.7), which is the *only* thing that wraps this
 * seam in Inngest-specific machinery.
 *
 * **Why this seam exists at all**: Prompt 3 needs to drive a full index end-to-end
 * against a synthetic tarball, in a unit/integration test, without standing up an
 * Inngest runtime. A function that only knows "given a resolved SHA and an installation,
 * produce a persisted `RepositoryFile` inventory" is directly callable from a test; a
 * `step.run`-laced Inngest function is not, short of a real Dev Server.
 *
 * **SHA resolution (`plan.md` §8.2 step 2) and the lock (step 1) are deliberately not
 * here.** Both need `@repo/github` calls this module has no reason to make and belong to
 * the Inngest function's own step boundaries (step 1's lock-then-create is a single
 * atomic decision that has no meaningful "retry the fetch, not the lock" seam to expose
 * here); `indexRepository` takes an *already-resolved* `sha`, exactly like
 * `fetchTarballStream` already does.
 *
 * **Temp-directory ownership has exactly one owner: `archive-extractor.ts`.** This
 * module never calls `fs.mkdir`/`fs.rm` on a temp path itself — it passes `tempRootDir`
 * straight through to {@link extractRepositoryArchive}, which creates a job-unique
 * subdirectory and removes it in a `finally` regardless of outcome (see that module's own
 * doc comment). Two owners of the same cleanup responsibility is how a directory either
 * leaks or gets removed out from under a still-running read; there is one owner here on
 * purpose.
 */

export interface IndexRepositoryOptions {
  installationId: bigint;
  owner: string;
  repo: string;
  sha: string;
  repositoryId: string;
  jobId: string;
  tempRootDir: string;
  maxTotalBytes: number;
  maxFileCount: number;
  logger?: Logger;
  /**
   * Invoked at a handful of coarse checkpoints (download start, extraction/walk done,
   * persistence done) — not per file. §20 asks for progress that "updates visibly
   * during a run"; per-file updates for a 200,000-file repository would be the write
   * amplification the prompt explicitly warns against, so the cadence is capped at this
   * function's own natural phase boundaries. `repository-index.ts` is what turns each
   * call into an `IndexJob` row update; this module has no idea Postgres exists.
   */
  onProgress?: (update: ProgressCheckpoint) => Promise<void>;
  /** Test seam — production uses the real `fetchTarballStream`. */
  fetchTarball?: typeof fetchTarballStream;
}

export interface ProgressCheckpoint {
  currentStep: string;
  progressPercent: number;
  filesTotal?: number;
  filesProcessed?: number;
  filesSkipped?: number;
}

export type IndexRepositoryResult =
  | {
      ok: true;
      /** `filesIndexed + filesSkipped + filesFailed` — see index-job.repository.ts's
       * header comment for why this excludes hard-ignored paths. */
      filesTotal: number;
      /** Successfully indexed only — what `Repository.indexedFileCount` stores. */
      filesIndexed: number;
      /** `filesIndexed + filesFailed` — what `IndexJob.filesProcessed` stores; see
       * index-job.repository.ts for why "processed" means "attempted", not "succeeded". */
      filesProcessed: number;
      filesFailed: number;
      filesSkipped: number;
      hardIgnoredCount: number;
      hardIgnoreRatio: number;
      staleRowsRemoved: number;
      extraction: ExtractionSummary;
    }
  // Reuses fetchTarballStream's own result vocabulary verbatim rather than wrapping it —
  // repository-index.ts's error handling should see the identical shape it would get by
  // calling fetchTarballStream directly.
  | { ok: false; reason: "REPO_NOT_FOUND" }
  | { ok: false; reason: "UNSAFE_REDIRECT"; host: string };

/**
 * Everything needed to turn a {@link WalkSummary} entry into a persisted row. `sha` is
 * threaded through as every row's `commitSha` (`plan.md` §24.2: one row per current
 * path, stamped with when it was last indexed — never one row per commit).
 */
function toUpsertInput(repositoryId: string, sha: string, file: WalkSummary["files"][number]): RepositoryFileUpsertInput {
  return {
    repositoryId,
    path: file.path,
    commitSha: sha,
    language: file.language,
    contentHash: file.contentHash,
    sizeBytes: file.sizeBytes,
    lineCount: file.lineCount,
    packageName: file.packageName,
    classification: file.classification,
    indexState: file.indexState,
    skipReason: file.skipReason,
    isTest: file.isTest,
    isGenerated: file.isGenerated,
  };
}

/**
 * See index-job.repository.ts's header comment for `filesProcessed` (= `filesIndexed +
 * filesFailed`) and `filesSkipped`'s definitions — this is where they're actually
 * applied to a walk's results. `filesIndexed` is split out separately from
 * `filesProcessed` because `Repository.indexedFileCount` (unlike `IndexJob.filesProcessed`)
 * means *successfully* indexed only — repository-index.ts's terminal step needs the
 * narrower number, `IndexJob`'s progress tracking needs the broader one, and both come
 * from the same walk.
 */
function countByBucket(files: WalkSummary["files"]): { filesIndexed: number; filesFailed: number; filesSkipped: number } {
  let filesIndexed = 0;
  let filesFailed = 0;
  let filesSkipped = 0;
  for (const file of files) {
    if (file.indexState === "SKIPPED") filesSkipped += 1;
    else if (file.indexState === "FAILED") filesFailed += 1;
    else filesIndexed += 1;
  }
  return { filesIndexed, filesFailed, filesSkipped };
}

export async function indexRepository(options: IndexRepositoryOptions): Promise<IndexRepositoryResult> {
  const logger = options.logger ?? createLogger("indexing.indexer-service");
  const fetchTarball = options.fetchTarball ?? fetchTarballStream;

  await options.onProgress?.({ currentStep: "download-tarball", progressPercent: 15 });

  const fetchOptions: TarballFetchOptions = { logger };
  const fetched = await fetchTarball(options.installationId, options.owner, options.repo, options.sha, fetchOptions);

  if (!fetched.ok) {
    logger.warn("indexRepository stopped: tarball fetch did not succeed", { repositoryId: options.repositoryId, reason: fetched.reason });
    return fetched;
  }

  await options.onProgress?.({ currentStep: "extract-filter-hash", progressPercent: 35 });

  const { walkSummary, extraction } = await extractRepositoryArchive(
    fetched.stream,
    {
      tempRootDir: options.tempRootDir,
      jobId: options.jobId,
      maxTotalBytes: options.maxTotalBytes,
      maxFileCount: options.maxFileCount,
      logger,
    },
    async (rootDir, summary) => {
      const walked = await walkTree(rootDir, { logger });
      return { walkSummary: walked, extraction: summary };
    },
  );

  const { filesIndexed, filesFailed, filesSkipped } = countByBucket(walkSummary.files);
  const filesProcessed = filesIndexed + filesFailed;
  const filesTotal = walkSummary.files.length;

  await options.onProgress?.({ currentStep: "persist-repository-files", progressPercent: 70, filesTotal });

  const upsertInputs = walkSummary.files.map((file) => toUpsertInput(options.repositoryId, options.sha, file));
  await upsertRepositoryFiles(upsertInputs);
  const staleRowsRemoved = await sweepStaleRepositoryFiles(options.repositoryId, options.sha);

  logger.info("indexRepository completed", {
    repositoryId: options.repositoryId,
    jobId: options.jobId,
    filesTotal,
    filesIndexed,
    filesFailed,
    filesSkipped,
    hardIgnoredCount: walkSummary.hardIgnoredCount,
    staleRowsRemoved,
  });

  await options.onProgress?.({ currentStep: "persisted", progressPercent: 90, filesProcessed, filesSkipped });

  return {
    ok: true,
    filesTotal,
    filesIndexed,
    filesProcessed,
    filesFailed,
    filesSkipped,
    hardIgnoredCount: walkSummary.hardIgnoredCount,
    hardIgnoreRatio: walkSummary.hardIgnoreRatio,
    staleRowsRemoved,
    extraction,
  };
}
