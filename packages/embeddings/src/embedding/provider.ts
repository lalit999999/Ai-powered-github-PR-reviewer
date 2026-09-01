import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "@repo/shared";

/**
 * Phase 05 prompt 3, sub-task 3.6 / §2.3: the embedding layer stays provider-independent
 * (Claude.md §4) — every caller (this package's own `embedding-client.ts`,
 * apps/worker's index-time embedding, apps/api's debug-search query-time embedding)
 * depends on this interface, never on a concrete SDK or HTTP shape.
 */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embedBatch(texts: readonly string[]): Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// Error vocabulary — matches packages/github/src/errors.ts's house style: an abstract
// base with a `code`, concrete subclasses the caller (embedding-client.ts) pattern-
// matches on to decide retriable vs. not, never a generic thrown Error.
// ---------------------------------------------------------------------------

export abstract class EmbeddingProviderError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** The provider answered with a non-2xx HTTP status. `status` is what
 * embedding-client.ts's error classification switches on (§ "Classify errors": 429/5xx
 * retriable, 400/401 not). */
export class EmbeddingProviderHttpError extends EmbeddingProviderError {
  readonly code = "EMBEDDING_PROVIDER_HTTP_ERROR";
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A 2xx response whose body did not match the expected shape (Claude.md §10: "External
 * API responses" must be validated) — a provider integration bug, not a transient
 * failure, so embedding-client.ts never retries this. */
export class EmbeddingProviderShapeError extends EmbeddingProviderError {
  readonly code = "EMBEDDING_PROVIDER_SHAPE_ERROR";
}

/** The provider returned a different vector count than inputs given, or a vector of the
 * wrong dimension. Both are silent-misalignment risks if allowed through — a 199-vector
 * response for 200 inputs would otherwise pair every chunk after the gap with someone
 * else's embedding. Never retried, for the same reason as
 * {@link EmbeddingProviderShapeError}. */
export class EmbeddingDimensionMismatchError extends EmbeddingProviderError {
  readonly code = "EMBEDDING_DIMENSION_MISMATCH";
}

// ---------------------------------------------------------------------------
// The real implementation
// ---------------------------------------------------------------------------

const embeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
      index: z.number().int(),
    }),
  ),
  model: z.string(),
});

/**
 * Voyage AI's `/v1/embeddings` endpoint — chosen over a general-purpose text-embedding
 * model per spec §4's stated preference for a code-specialized model when available.
 * `voyage-code-3` supports an `output_dimension` request parameter that pins the
 * response to exactly `EMBEDDING_DIMENSIONS` (1024) without a separate truncation step.
 * The request/response shape (`{ input, model } -> { data: [{ embedding, index }] }`) is
 * the same OpenAI-compatible convention most embedding providers share, so swapping
 * providers later is a change to this one file, not to the `EmbeddingProvider`
 * interface or any of its callers.
 *
 * There is no `EMBEDDING_BASE_URL` config variable (spec §19 names only
 * `EMBEDDING_MODEL`/`EMBEDDING_API_KEY`) — the endpoint is fixed here deliberately, not
 * left configurable, matching spec §19's own reasoning for `EMBEDDING_MODEL` having no
 * silent default: which provider is in use is a tracked decision, not something an env
 * var should be able to silently redirect.
 */
const EMBEDDINGS_API_URL = "https://api.voyageai.com/v1/embeddings";

export interface RealEmbeddingProviderOptions {
  apiKey: string;
  model: string;
  dimensions?: number;
  /** Test seam — defaults to the global `fetch`. Never used to point at a different
   * provider in production; only to inject a fake in unit tests (Claude.md §30: no test
   * may call a real embedding provider). */
  fetchImpl?: typeof fetch;
}

export class RealEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RealEmbeddingProviderOptions) {
    this.model = options.model;
    this.dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    const response = await this.fetchImpl(EMBEDDINGS_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        output_dimension: this.dimensions,
      }),
    });

    if (!response.ok) {
      throw new EmbeddingProviderHttpError(
        `embedding provider responded with HTTP ${String(response.status)}`,
        response.status,
      );
    }

    const json: unknown = await response.json();
    const parsed = embeddingResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new EmbeddingProviderShapeError(
        "embedding provider response did not match the expected shape",
      );
    }

    if (parsed.data.data.length !== texts.length) {
      throw new EmbeddingDimensionMismatchError(
        `embedding provider returned ${String(parsed.data.data.length)} vector(s) for ` +
          `${String(texts.length)} input(s)`,
      );
    }

    const vectors = [...parsed.data.data]
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.embedding);

    for (const vector of vectors) {
      if (vector.length !== this.dimensions) {
        throw new EmbeddingDimensionMismatchError(
          `embedding provider returned a ${String(vector.length)}-dimension vector, ` +
            `expected ${String(this.dimensions)}`,
        );
      }
    }

    return vectors;
  }
}

export function createEmbeddingProvider(options: {
  apiKey: string;
  model: string;
}): EmbeddingProvider {
  return new RealEmbeddingProvider(options);
}
