import { createLogger, type Logger } from "@repo/observability";
import { EMBEDDING_BATCH_SIZE } from "@repo/shared";
import {
  EmbeddingDimensionMismatchError,
  EmbeddingProviderHttpError,
  EmbeddingProviderShapeError,
  type EmbeddingProvider,
} from "./provider.js";

/**
 * Phase 05 prompt 3, sub-task 3.6: batches chunk text to an {@link EmbeddingProvider},
 * retrying a failed batch with exponential backoff while halving its size, and returns a
 * partial result rather than throwing — the caller (Prompt 4's pipeline) needs to know
 * exactly which chunks got vectors so it can set `chunksEmbedded < total` and land the
 * repository in `PARTIAL` (spec §4/§8) rather than losing that information to a thrown
 * error.
 */

export interface EmbedItem {
  contentHash: string;
  text: string;
}

export interface EmbedManyResult {
  /** contentHash -> embedding vector, for every item that succeeded. */
  embedded: Map<string, number[]>;
  /** contentHashes that never got a vector, after every retry was exhausted or a
   * non-retriable error was hit. */
  failed: string[];
  /** Total provider HTTP calls made across the whole run — every attempt at every batch
   * size, successful or not. */
  attempts: number;
}

export interface EmbedManyOptions {
  /**
   * For the per-batch log line only (spec §20) — how many chunks in this indexing run
   * were already cache hits and never reached this function at all. This module never
   * touches the embedding cache itself (`embedding-cache.repository.ts`, sub-task 3.7,
   * and its caller in Prompt 4 own that); the caller passes the count purely so the
   * batch-call log line can carry it.
   */
  cacheHitCount?: number;
  logger?: Logger;
  /** Test seam — defaults to a real `setTimeout`-based delay. */
  sleep?: (ms: number) => Promise<void>;
}

/** Four attempts total, halving the batch size each retry: 96 → 48 → 24 → 12 (spec §8). */
const MAX_ATTEMPTS = 4;
/** Exponential backoff base — attempt 2 waits this long, attempt 3 doubles it, attempt 4
 * doubles again (250ms / 500ms / 1000ms). Small enough that the retry ladder for one
 * stuck batch does not eat meaningfully into the Inngest step's 30-minute budget even in
 * the worst case (a handful of batches, each retrying up to 3 times). */
const RETRY_BASE_DELAY_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Error classification — spec §8's table, as code
// ---------------------------------------------------------------------------

export type ErrorClassification = "retriable" | "non-retriable";

/**
 | Error                                          | Classification  | Behaviour                                   |
 | ----------------------------------------------- | --------------- | -------------------------------------------- |
 | `EmbeddingProviderHttpError` status 429          | retriable       | retry with backoff, halved batch             |
 | `EmbeddingProviderHttpError` status 5xx          | retriable       | retry with backoff, halved batch             |
 | `EmbeddingProviderHttpError` status 400          | non-retriable   | fail this batch's items immediately          |
 | `EmbeddingProviderHttpError` status 401          | non-retriable   | fail this batch's items immediately          |
 | `EmbeddingProviderHttpError`, any other status   | non-retriable   | fail this batch's items immediately          |
 | `EmbeddingProviderShapeError`                    | non-retriable   | a malformed response is a provider/integration bug, not transient |
 | `EmbeddingDimensionMismatchError`                | non-retriable   | same request would produce the same mismatch again |
 | anything else (network failure, timeout, ...)    | retriable       | assumed transient, same as a 5xx              |
 */
export function classifyEmbeddingError(error: unknown): ErrorClassification {
  if (error instanceof EmbeddingProviderHttpError) {
    if (error.status === 429 || error.status >= 500) return "retriable";
    return "non-retriable";
  }
  if (
    error instanceof EmbeddingProviderShapeError ||
    error instanceof EmbeddingDimensionMismatchError
  ) {
    return "non-retriable";
  }
  return "retriable";
}

// ---------------------------------------------------------------------------
// The batching/retry core
// ---------------------------------------------------------------------------

interface AttemptContext {
  provider: EmbeddingProvider;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
  cacheHitCount: number;
  embedded: Map<string, number[]>;
  failed: string[];
  attempts: number;
}

async function attemptBatch(
  items: readonly EmbedItem[],
  attemptNumber: number,
  ctx: AttemptContext,
): Promise<void> {
  if (attemptNumber > 1) {
    const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attemptNumber - 2);
    await ctx.sleep(delayMs);
  }

  const startedAtMs = Date.now();
  ctx.attempts += 1;
  try {
    const vectors = await ctx.provider.embedBatch(items.map((i) => i.text));
    ctx.logger.info("embedding batch call succeeded", {
      batchSize: items.length,
      attempt: attemptNumber,
      latencyMs: Date.now() - startedAtMs,
      cacheHitCount: ctx.cacheHitCount,
      model: ctx.provider.model,
    });
    items.forEach((item, index) => {
      ctx.embedded.set(item.contentHash, vectors[index]!);
    });
  } catch (error) {
    const classification = classifyEmbeddingError(error);
    ctx.logger.warn("embedding batch call failed", {
      batchSize: items.length,
      attempt: attemptNumber,
      latencyMs: Date.now() - startedAtMs,
      classification,
      errorCode: error instanceof Error ? error.name : "unknown",
      errorMessage: error instanceof Error ? error.message : String(error),
      model: ctx.provider.model,
    });

    if (classification === "non-retriable" || attemptNumber >= MAX_ATTEMPTS) {
      ctx.failed.push(...items.map((i) => i.contentHash));
      return;
    }

    const mid = Math.ceil(items.length / 2);
    const first = items.slice(0, mid);
    const second = items.slice(mid);
    await attemptBatch(first, attemptNumber + 1, ctx);
    if (second.length > 0) {
      await attemptBatch(second, attemptNumber + 1, ctx);
    }
  }
}

/**
 * Embeds `items` via `provider`, batching at {@link EMBEDDING_BATCH_SIZE} (96) and
 * retrying a failed batch per {@link classifyEmbeddingError}'s table. Never throws for a
 * provider failure — see {@link EmbedManyResult}'s own doc comment for why a partial
 * result, not an exception, is the contract.
 */
export async function embedMany(
  provider: EmbeddingProvider,
  items: readonly EmbedItem[],
  options: EmbedManyOptions = {},
): Promise<EmbedManyResult> {
  const ctx: AttemptContext = {
    provider,
    logger: options.logger ?? createLogger("indexing.embedding-client"),
    sleep: options.sleep ?? defaultSleep,
    cacheHitCount: options.cacheHitCount ?? 0,
    embedded: new Map(),
    failed: [],
    attempts: 0,
  };

  for (let offset = 0; offset < items.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = items.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    await attemptBatch(batch, 1, ctx);
  }

  return { embedded: ctx.embedded, failed: ctx.failed, attempts: ctx.attempts };
}
