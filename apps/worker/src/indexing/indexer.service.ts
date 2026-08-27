import { createLogger, type Logger } from "@repo/observability";
import { extractRepositoryArchive, type ExtractionSummary } from "./fetcher/archive-extractor.js";
import { fetchTarballStream, type TarballFetchOptions } from "./fetcher/tarball-fetcher.js";
import { buildKnowledgeGraph } from "./graph/graph-builder.js";
import { buildRepoContext } from "./graph/repo-context.js";
import { countInboundEdgesByFile } from "./persistence/code-dependency.repository.js";
import {
  findRepositoryFilesByCommit,
  sweepStaleRepositoryFiles,
  updateRepositoryFileGraphMetadata,
  upsertRepositoryFiles,
  type RepositoryFileGraphMetadataUpdate,
  type RepositoryFileUpsertInput,
} from "./persistence/repository-file.repository.js";
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
 *
 * **Phase 04 addendum (sub-task 4.6): `upsertRepositoryFiles`/`sweepStaleRepositoryFiles`
 * moved inside `onExtracted`.** Prompt 3 ran them *after* `extractRepositoryArchive`
 * returned, which was fine while nothing downstream needed the live filesystem. Building
 * the knowledge graph needs both the persisted `RepositoryFile` ids (to stamp as
 * `CodeSymbol.fileId`/edge endpoints) *and* the still-live `rootDir` to read source text
 * from — and `rootDir` is removed the instant `onExtracted` returns (this module's own
 * previous paragraph). So the persist step, the repo-context build, and the graph build
 * all now run inside the same callback, in that order; nothing outside it may assume the
 * extracted tree still exists.
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
  /** Inngest's `attempt` — threaded through to {@link buildKnowledgeGraph}'s
   * `batchSizeForAttempt`. `0` for a fresh run (`repository-index.ts`'s own handler
   * parameter, passed straight through, matching how `attempt` already flows into
   * `record-attempt-N`). */
  attempt: number;
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
      /** Phase 04 (sub-task 4.6) — `buildKnowledgeGraph`'s own result, passed through
       * verbatim rather than re-shaped; `repository-index.ts`'s `slim()` is what narrows
       * this to scalars before it ever reaches Inngest step state. */
      symbolsCreated: number;
      edgesCreated: number;
      parseFailureCount: number;
      unresolvedImportRatio: number;
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

  await options.onProgress?.({ currentStep: "download-tarball", progressPercent: 10 });

  const fetchOptions: TarballFetchOptions = { logger };
  const fetched = await fetchTarball(options.installationId, options.owner, options.repo, options.sha, fetchOptions);

  if (!fetched.ok) {
    logger.warn("indexRepository stopped: tarball fetch did not succeed", { repositoryId: options.repositoryId, reason: fetched.reason });
    return fetched;
  }

  await options.onProgress?.({ currentStep: "extract-filter-hash", progressPercent: 25 });

  const { walkSummary, extraction, staleRowsRemoved, graphResult } = await extractRepositoryArchive(
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

      const upsertInputs = walked.files.map((file) => toUpsertInput(options.repositoryId, options.sha, file));
      await upsertRepositoryFiles(upsertInputs);
      const staleRemoved = await sweepStaleRepositoryFiles(options.repositoryId, options.sha);

      await options.onProgress?.({ currentStep: "persist-repository-files", progressPercent: 40, filesTotal: walked.files.length });

      // The graph builder needs real ids, and an upsert conflict discards the caller's
      // generated id in favor of the existing row's own (repository-file.repository.ts's
      // own comment) — the only honest way to learn them is to ask, after the upsert
      // commits, scoped to this run's own commitSha.
      const persistedFiles = await findRepositoryFilesByCommit(options.repositoryId, options.sha);
      const repoContext = await buildRepoContext(
        rootDir,
        walked.files.map((file) => file.path),
      );

      await options.onProgress?.({ currentStep: "build-graph", progressPercent: 55 });

      const graph = await buildKnowledgeGraph({
        rootDir,
        files: persistedFiles,
        repoContext,
        repositoryId: options.repositoryId,
        commitSha: options.sha,
        attempt: options.attempt,
        logger,
      });

      const inboundCounts = await countInboundEdgesByFile(options.repositoryId);
      const inboundByFileId = new Map(inboundCounts.map((row) => [row.fileId, row.inboundEdgeCount]));
      const metadataUpdates: RepositoryFileGraphMetadataUpdate[] = graph.fileGraphMetadata.map((meta) => ({
        fileId: meta.fileId,
        symbolCount: meta.symbolCount,
        inboundEdgeCount: inboundByFileId.get(meta.fileId) ?? 0,
        parseState: meta.parseState,
        packageName: meta.packageName,
        isTest: meta.isTest,
      }));
      await updateRepositoryFileGraphMetadata(metadataUpdates);

      await options.onProgress?.({ currentStep: "graph-built", progressPercent: 85 });

      return { walkSummary: walked, extraction: summary, staleRowsRemoved: staleRemoved, graphResult: graph };
    },
  );

  const { filesIndexed, filesFailed, filesSkipped } = countByBucket(walkSummary.files);
  const filesProcessed = filesIndexed + filesFailed;
  const filesTotal = walkSummary.files.length;

  logger.info("indexRepository completed", {
    repositoryId: options.repositoryId,
    jobId: options.jobId,
    filesTotal,
    filesIndexed,
    filesFailed,
    filesSkipped,
    hardIgnoredCount: walkSummary.hardIgnoredCount,
    staleRowsRemoved,
    symbolsCreated: graphResult.symbolsCreated,
    edgesCreated: graphResult.edgesCreated,
    parseFailureCount: graphResult.parseFailureCount,
    unresolvedImportRatio: Number(graphResult.unresolvedImportRatio.toFixed(3)),
  });

  await options.onProgress?.({ currentStep: "persisted", progressPercent: 95, filesProcessed, filesSkipped });

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
    symbolsCreated: graphResult.symbolsCreated,
    edgesCreated: graphResult.edgesCreated,
    parseFailureCount: graphResult.parseFailureCount,
    unresolvedImportRatio: graphResult.unresolvedImportRatio,
  };
}
