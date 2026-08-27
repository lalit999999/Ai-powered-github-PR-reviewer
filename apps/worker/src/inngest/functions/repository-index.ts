import os from "node:os";
import {
  GithubAccessRevokedError,
  GithubRateLimitError,
  repositoryGithub,
} from "@repo/github";
import { createLogger } from "@repo/observability";
import { INDEX_ERROR_CODES, type IndexErrorCode } from "@repo/shared";
import { NonRetriableError } from "inngest";
import { env } from "../../config/env.js";
import { ArchiveTooLargeError, UnsafeArchiveError } from "../../indexing/fetcher/archive-extractor.js";
import { indexRepository, type IndexRepositoryResult } from "../../indexing/indexer.service.js";
import * as indexJobRepository from "../../indexing/persistence/index-job.repository.js";
import * as repositoryRepository from "../../indexing/persistence/repository.repository.js";
import { inngest } from "../client.js";
import { projectDeleted, repositoryIndexed, repositoryIndexRequested } from "../events.js";

/**
 * `plan.md` §8.2 steps 1–6 plus this phase's own early terminal step (phase-03 §8) — the
 * centrepiece of Prompt 2. Composes the lock, SHA resolution, and terminal
 * state-transitions around `indexer.service.ts`'s Inngest-agnostic fetch→persist seam.
 *
 * **This phase's `INDEXED` is deliberately narrow** (phase-03-repository-indexing.md
 * §1): "the file inventory is complete", nothing about symbols, edges, chunks, or
 * embeddings. Phase 04 appends steps 7–9 and relocates the terminal step (marked below)
 * to after them; Phase 05 relocates it again after steps 10–13. **Same function,
 * extended in place, never rebuilt** — every step below is written assuming a later
 * phase inserts code between "persist" and "terminal", not that it rewrites this file.
 */

const logger = createLogger("indexing.repository-index");

// ---------------------------------------------------------------------------
// The error-code-in-message convention this function uses end to end
// ---------------------------------------------------------------------------

/**
 * `onFailure` (below) runs as a **separate invocation** with no closure over anything
 * the main handler computed — it only receives the final `Error` Inngest hands it, which
 * has been round-tripped through Inngest's own `JsonError` serialization
 * (`node_modules/inngest`'s `jsonErrorSchema`: `{ name, message, stack, cause? }`).
 * `message` is the one field guaranteed to survive that round trip un-mangled, so the
 * `IndexErrorCode` is threaded through as a `"CODE: message"` prefix on `.message`
 * itself, parsed back out in `onFailure` — deliberately not relying on `.cause`
 * surviving serialization, which this codebase has no way to verify without a live
 * Inngest Cloud round trip (see docs/decisions/phase-03-log.md, "outstanding").
 */
const CODE_SEPARATOR = ": ";

export function withCode(code: IndexErrorCode, message: string): string {
  return `${code}${CODE_SEPARATOR}${message}`;
}

export function parseCode(message: string): { code: IndexErrorCode | "UNKNOWN"; message: string } {
  const separatorIndex = message.indexOf(CODE_SEPARATOR);
  if (separatorIndex === -1) return { code: "UNKNOWN", message };
  const candidate = message.slice(0, separatorIndex);
  const rest = message.slice(separatorIndex + CODE_SEPARATOR.length);
  if ((INDEX_ERROR_CODES as readonly string[]).includes(candidate)) {
    return { code: candidate as IndexErrorCode, message: rest };
  }
  return { code: "UNKNOWN", message };
}

// ---------------------------------------------------------------------------
// Step 3–6 as one coarse, retriable unit — see indexer.service.ts's own header
// comment for why extraction/walk/persist can't cleanly be separate Inngest steps
// (the extracted temp directory only exists for the duration of one callback).
// ---------------------------------------------------------------------------

type SlimIndexResult = Pick<
  Extract<IndexRepositoryResult, { ok: true }>,
  | "filesTotal"
  | "filesIndexed"
  | "filesProcessed"
  | "filesFailed"
  | "filesSkipped"
  | "hardIgnoredCount"
  | "staleRowsRemoved"
  | "symbolsCreated"
  | "edgesCreated"
  | "parseFailureCount"
  | "unresolvedImportRatio"
>;

/** plan.md §27.5 rule 3: step outputs are serialized into Inngest's state and must stay
 * small. `IndexRepositoryResult`'s `extraction.skipped` array can hold one entry per
 * rejected archive entry — never returned from a step; only these scalar counts are.
 * Phase 04 (sub-task 4.6) adds the four graph-builder scalars — still just counts/ratios,
 * never the `fileGraphMetadata` array `buildKnowledgeGraph` itself returns. */
function slim(result: Extract<IndexRepositoryResult, { ok: true }>): SlimIndexResult {
  return {
    filesTotal: result.filesTotal,
    filesIndexed: result.filesIndexed,
    filesProcessed: result.filesProcessed,
    filesFailed: result.filesFailed,
    filesSkipped: result.filesSkipped,
    hardIgnoredCount: result.hardIgnoredCount,
    staleRowsRemoved: result.staleRowsRemoved,
    symbolsCreated: result.symbolsCreated,
    edgesCreated: result.edgesCreated,
    parseFailureCount: result.parseFailureCount,
    unresolvedImportRatio: result.unresolvedImportRatio,
  };
}

type FetchExtractOutcome = { rateLimited: true; retryAfterSeconds: number } | { rateLimited: false; result: SlimIndexResult };

interface FetchExtractArgs {
  installationId: bigint;
  owner: string;
  repo: string;
  sha: string;
  repositoryId: string;
  jobId: string;
  /** Inngest's own `attempt` (the function handler's parameter) — threaded straight
   * through to `indexRepository`, which threads it to `buildKnowledgeGraph`'s
   * attempt-aware batch sizing. A fresh step id per real retry (see `record-attempt-N`
   * below) means this is the same number on every re-invocation of this step for a given
   * attempt. */
  attempt: number;
}

/**
 * Runs `indexer.service.ts`'s whole fetch→persist seam and classifies the outcome.
 *
 * **`GithubRateLimitError` is the one failure this function does not throw for.**
 * Everything else that should stop the run entirely throws `NonRetriableError` *from
 * inside this step's own callback* — which is what actually prevents Inngest's
 * automatic per-step retry from wasting attempts on a permanent failure; a
 * `NonRetriableError` thrown here, uncaught, propagates out of `step.run` exactly like
 * any other rejection and is what ultimately reaches `onFailure` below. A rate limit is
 * different: §8/§12 specify `step.sleepUntil(resetTime), resume` as *the* retry
 * mechanism, not Inngest's own blind exponential backoff — so this function returns a
 * `{ rateLimited: true, ... }` *successful* step result instead of throwing, and the
 * caller (the function handler, below) is what turns that into a real
 * `step.sleepUntil` call followed by a fresh retry attempt under a new step id.
 *
 * Every other classified failure (`UnsafeArchiveError`, `ArchiveTooLargeError`,
 * `GithubAccessRevokedError`, and the tarball-fetcher's own `REPO_NOT_FOUND`/
 * `UNSAFE_REDIRECT` result variants) becomes `NonRetriableError` with the matching
 * `IndexErrorCode` prefix. An unclassified error (a 5xx or network failure the
 * tarball-fetcher deliberately throws as a plain `Error` — see that module's own header
 * comment on why it does not retry internally) is re-thrown unchanged, letting
 * Inngest's own per-step retry (this function's `retries: 3`) own the backoff.
 */
export async function runFetchExtractPersist(args: FetchExtractArgs): Promise<FetchExtractOutcome> {
  try {
    const result = await indexRepository({
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      sha: args.sha,
      repositoryId: args.repositoryId,
      jobId: args.jobId,
      tempRootDir: env.WORKER_TEMP_DIR ?? os.tmpdir(),
      maxTotalBytes: env.INDEX_MAX_TOTAL_BYTES,
      maxFileCount: env.INDEX_MAX_FILE_COUNT,
      attempt: args.attempt,
      logger,
    });

    if (!result.ok) {
      if (result.reason === "REPO_NOT_FOUND") {
        throw new NonRetriableError(withCode("REPO_NOT_FOUND", "The repository tarball could not be found"));
      }
      // UNSAFE_REDIRECT — the SSRF defense tripped (tarball-fetcher.ts). Same "looks
      // tampered with, abort, no detail past this code" family as UNSAFE_ARCHIVE.
      throw new NonRetriableError(withCode("UNSAFE_ARCHIVE", "The tarball download did not pass validation"));
    }

    return { rateLimited: false, result: slim(result) };
  } catch (error) {
    if (error instanceof GithubRateLimitError) {
      const retryAfterSeconds =
        typeof error.details.retryAfterSeconds === "number" && error.details.retryAfterSeconds >= 0
          ? error.details.retryAfterSeconds
          : 60;
      return { rateLimited: true, retryAfterSeconds };
    }
    if (error instanceof UnsafeArchiveError) {
      throw new NonRetriableError(withCode("UNSAFE_ARCHIVE", "The archive failed a safety check"));
    }
    if (error instanceof ArchiveTooLargeError) {
      throw new NonRetriableError(withCode("REPO_TOO_LARGE", "The repository exceeds the current size limit"));
    }
    if (error instanceof GithubAccessRevokedError) {
      throw new NonRetriableError(withCode("ACCESS_REVOKED", "GitHub access was revoked for this installation"));
    }
    // NonRetriableError thrown above, or a plain transient Error — propagate unchanged.
    throw error;
  }
}

/** A rate limit this function will wait out at most this many times before giving up —
 * a safety valve against a pathological "GitHub never resets" case; the function's own
 * 30-minute `timeouts.finish` would eventually kill the run regardless, but an explicit,
 * intentional cap reads better than relying on that as the only backstop. */
const MAX_RATE_LIMIT_SLEEPS = 5;

// ---------------------------------------------------------------------------
// The function
// ---------------------------------------------------------------------------

export const repositoryIndex = inngest.createFunction(
  {
    id: "repository-index",
    retries: 3,
    // plan.md §27.2: 2 per repository key (a repository never has more than 2 index
    // attempts genuinely in flight — the lock in step 1 makes a third redundant before
    // it ever reaches this limit), 20 global (this function's own fn-scoped ceiling,
    // `scope` defaults to "fn" — see ConcurrencyOption's own doc comment in the
    // installed inngest@4.18.1 types, verified before relying on the default).
    concurrency: [{ key: "event.data.repositoryId", limit: 2 }, { limit: 20 }],
    timeouts: { finish: "30m" },
    // `if`, not the deprecated `match` the phase document's own plan.md §27.3 example
    // uses — verified against the installed inngest@4.18.1's own `Cancellation` type,
    // which marks `match` `@deprecated` in favor of `if`. Forward-declared since Phase
    // 01 specifically so this phase could attach it (phase-01-log.md §8; packages/shared's
    // events.ts says so in as many words).
    cancelOn: [{ event: projectDeleted, if: "async.data.projectId == event.data.projectId" }],
    triggers: { event: repositoryIndexRequested },
    onFailure: async ({ event, error, step }) => {
      const original = event.data.event.data;
      const { code, message } = parseCode(error.message);

      logger.error("repository-index failed terminally", {
        repositoryId: original.repositoryId,
        runId: event.data.run_id,
        code,
        message,
      });

      await step.run("mark-repository-failed", () => repositoryRepository.markFailed({ repositoryId: original.repositoryId, code, message }));

      const job = await step.run("find-job-for-failure", () => indexJobRepository.findByInngestRunId(event.data.run_id));
      if (job) {
        await step.run("mark-job-failed", () => indexJobRepository.markFailed(job.id, { code, message }));
      }
    },
  },
  async ({ event, step, runId, attempt }) => {
    const { repositoryId } = event.data;

    // ---- Step 1: acquire lock + create IndexJob. ----
    const lock = await step.run("acquire-lock", () => repositoryRepository.acquireIndexingLock(repositoryId));

    if (!lock.acquired) {
      // §11/§12: zero rows affected means another index is already in flight. Exit
      // gracefully — no second IndexJob, no error. The UI simply shows the in-progress job.
      logger.info("repository-index exiting gracefully — another index is already in flight", { repositoryId });
      return { skipped: true as const, reason: "ALREADY_INDEXING" as const };
    }

    const job = await step.run("create-index-job", () =>
      indexJobRepository.createIndexJob({
        repositoryId,
        mode: event.data.mode,
        inngestRunId: runId,
        id: event.data.indexJobId,
      }),
    );

    // Genuine retries only (never the run's first attempt, which createIndexJob's own
    // attempts:1 already counts) — a fresh step id per attempt number means this
    // actually re-executes on every real retry rather than being memoized away, which a
    // plain step.run at a fixed id would be after its first success.
    if (attempt > 0) {
      await step.run(`record-attempt-${attempt.toString()}`, () => indexJobRepository.incrementAttempts(job.id));
    }

    // ---- Step 2: resolve target SHA. ----
    // Uses the Repository row's own stored owner/name/defaultBranch — set fresh by
    // Phase 02's connect flow — rather than re-fetching GET /repos/{o}/{r}. See
    // repository.repository.ts's findIndexTarget doc comment: re-fetching metadata on
    // every index run would make this phase's own repeated acceptance criterion
    // ("exactly two GitHub API calls per full index run" — §9/§14/§15) unsatisfiable
    // against §8.2's literal three-call step list, and the two-call version is what
    // every verification section actually asserts.
    // Step outputs are serialized into Inngest's own state (plan.md §27.5 rule 3), and
    // JSON has no bigint — verified directly against the installed inngest@4.18.1's own
    // `Jsonify`-typed step-return signatures, which strip a `bigint` field entirely
    // rather than coercing it. `installationId` is threaded through this function as a
    // decimal string from this point on and parsed back to `bigint` only at the two
    // call sites (`getHeadCommit`, `indexRepository`) that need the real type.
    const target = await step.run("resolve-target", async () => {
      const row = await repositoryRepository.findIndexTarget(repositoryId);
      return row ? { ...row, installationId: row.installationId.toString() } : null;
    });

    if (!target) {
      // The Repository row itself vanished between the lock and this read — abnormal,
      // and nothing about retrying would fix it.
      throw new NonRetriableError(withCode("REPO_NOT_FOUND", "The repository record no longer exists"));
    }

    const installationId = BigInt(target.installationId);

    const commitResult = await step.run("resolve-head-sha", () =>
      repositoryGithub.getHeadCommit(installationId, target.owner, target.name, target.defaultBranch),
    );

    if (!commitResult.ok) {
      if (commitResult.reason === "NOT_ACCESSIBLE") {
        // §9: "404 branch missing" — the repository metadata call already succeeded
        // once at connect time, so this means the branch (or the repository itself) is
        // gone now. Treated the same as a gone repository (§12).
        throw new NonRetriableError(withCode("REPO_NOT_FOUND", "The repository or its default branch could not be found"));
      }
      // UNAVAILABLE/UNAUTHENTICATED — transient from this call's point of view (see
      // repository.github.ts's getHeadCommit doc comment on why a revoked-installation
      // token-mint failure collapses into UNAVAILABLE here rather than surfacing as
      // GithubAccessRevokedError — classifyGithubError's own duck-typing has no
      // `.status` field to find on that error class). A plain, uncoded Error lets
      // Inngest's normal per-step retry own the backoff.
      throw new Error(`transient failure resolving the repository's head commit (reason: ${commitResult.reason})`);
    }

    const targetCommitSha = commitResult.commit.sha;

    // ---- No-op short-circuit (§8/§11): already indexed at this exact SHA. ----
    if (target.indexedCommitSha === targetCommitSha) {
      await step.run("mark-noop-succeeded", () => indexJobRepository.markSucceededNoOp(job.id));
      logger.info("repository-index no-op — already indexed at this commit", { repositoryId, jobId: job.id, commitSha: targetCommitSha });
      // §10's flow diagram routes the no-op path straight to "mark SUCCEEDED, no-op" —
      // it does not pass through "emit repository.indexed". Nothing changed, so there
      // is nothing new for a downstream consumer to react to.
      return { skipped: true as const, reason: "ALREADY_INDEXED" as const, commitSha: targetCommitSha };
    }

    await step.run("record-target-sha", () =>
      indexJobRepository.updateProgress(job.id, { currentStep: "resolve-sha", progressPercent: 10, targetCommitSha }),
    );

    // ---- Steps 3–6: fetch, filter, hash, persist — one coarse, rate-limit-aware unit. ----
    const fetchArgs: FetchExtractArgs = {
      installationId,
      owner: target.owner,
      repo: target.name,
      sha: targetCommitSha,
      repositoryId,
      jobId: job.id,
      attempt,
    };

    let outcome = await step.run("fetch-extract-persist", () => runFetchExtractPersist(fetchArgs));
    let rateLimitSleeps = 0;

    while (outcome.rateLimited) {
      rateLimitSleeps += 1;
      if (rateLimitSleeps > MAX_RATE_LIMIT_SLEEPS) {
        throw new NonRetriableError(withCode("TARBALL_DOWNLOAD_FAILED", "exceeded the maximum number of rate-limit waits"));
      }

      const resetAt = new Date(Date.now() + outcome.retryAfterSeconds * 1000);
      logger.info("repository-index sleeping for a GitHub rate limit — the sleep is the retry", {
        repositoryId,
        jobId: job.id,
        retryAfterSeconds: outcome.retryAfterSeconds,
        attempt: rateLimitSleeps,
      });
      await step.sleepUntil(`rate-limit-sleep-${rateLimitSleeps.toString()}`, resetAt);

      outcome = await step.run(`fetch-extract-persist-retry-${rateLimitSleeps.toString()}`, () => runFetchExtractPersist(fetchArgs));
    }

    const indexResult = outcome.result;

    await step.run("record-persist-progress", () =>
      indexJobRepository.updateProgress(job.id, {
        currentStep: "persisted",
        progressPercent: 90,
        filesTotal: indexResult.filesTotal,
        filesProcessed: indexResult.filesProcessed,
        filesSkipped: indexResult.filesSkipped,
      }),
    );

    // ---- This phase's terminal step. ----
    // Phase 04 relocates this block to after its own new steps 7–9 (parse, symbols,
    // edges); Phase 05 relocates it again to after steps 10–13 (chunk, embed, review
    // profile). The same function, extended in place — this block is written to be
    // *moved*, not rewritten: nothing above it depends on anything below it.
    await step.run("mark-repository-indexed", () =>
      repositoryRepository.markIndexed({
        repositoryId,
        commitSha: targetCommitSha,
        indexedFileCount: indexResult.filesIndexed,
        skippedFileCount: indexResult.filesSkipped,
      }),
    );

    await step.run("mark-job-succeeded", () =>
      indexJobRepository.markSucceeded(job.id, {
        filesTotal: indexResult.filesTotal,
        filesProcessed: indexResult.filesProcessed,
        filesSkipped: indexResult.filesSkipped,
        symbolsCreated: indexResult.symbolsCreated,
        edgesCreated: indexResult.edgesCreated,
      }),
    );

    await step.sendEvent("emit-repository-indexed", {
      name: repositoryIndexed.name,
      data: {
        projectId: event.data.projectId,
        repositoryId,
        commitSha: targetCommitSha,
        fileCount: indexResult.filesIndexed,
        durationMs: 0, // Inngest does not expose a run-start timestamp to the handler;
        // see docs/decisions/phase-03-log.md for why this is left at 0 rather than
        // guessed from wall-clock time measured inside a function that may itself be
        // replayed/resumed across a sleep.
      },
    });

    logger.info("repository-index completed", {
      repositoryId,
      jobId: job.id,
      commitSha: targetCommitSha,
      filesTotal: indexResult.filesTotal,
      filesIndexed: indexResult.filesIndexed,
      filesFailed: indexResult.filesFailed,
      filesSkipped: indexResult.filesSkipped,
      hardIgnoredCount: indexResult.hardIgnoredCount,
      staleRowsRemoved: indexResult.staleRowsRemoved,
      symbolsCreated: indexResult.symbolsCreated,
      edgesCreated: indexResult.edgesCreated,
      parseFailureCount: indexResult.parseFailureCount,
      unresolvedImportRatio: indexResult.unresolvedImportRatio,
    });

    return { skipped: false as const, commitSha: targetCommitSha, ...indexResult };
  },
);
