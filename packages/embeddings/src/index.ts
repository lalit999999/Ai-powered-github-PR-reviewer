/**
 * Public barrel for @repo/embeddings — Phase 05 prompt 3's chunking, embedding, and
 * cache layer, consumed by apps/worker (index-time embedding) and apps/api (query-time
 * embedding for the debug search panel). See docs/decisions/phase-05-log.md, Prompt 3
 * section, for the full set of decisions behind this package's shape.
 *
 * `FakeEmbeddingProvider` is deliberately NOT exported here — it lives behind the
 * `./testing` subpath (src/testing.ts) so production code cannot accidentally import a
 * test double (Claude.md §30).
 */

// ---------------------------------------------------------------------------
// Chunking (sub-tasks 3.2-3.5) — `chunkFile` is the one entry point Prompt 4's pipeline
// calls; the two chunkers and `assertChunkInvariants` are exported too since Prompt 4's
// own tests, and any future caller with a reason to force one path or the other, need
// them directly rather than only through the router's predicate.
// ---------------------------------------------------------------------------
export {
  chunkFile,
  assertChunkInvariants,
  chunkFileWithAst,
  chunkFileWithWindows,
  ChunkInvariantViolation,
  computeContentHash,
  formatChunkHeader,
  CHARS_PER_TOKEN_ESTIMATE,
  estimateTokens,
  type ChunkableFile,
  type ChunkableImport,
  type ChunkableSymbol,
  type ChunkHeaderInput,
  type CodeChunkDraft,
} from "./chunking/index.js";

// ---------------------------------------------------------------------------
// Embedding provider (sub-task 3.6) — `EmbeddingProvider` is the interface every
// caller depends on; `createEmbeddingProvider` is the one sanctioned way to build the
// real implementation (never `new RealEmbeddingProvider(...)` directly outside this
// package, so the concrete class stays free to change). The error classes are public so
// a caller can branch on `instanceof` the same way `embedding-client.ts` itself does.
// ---------------------------------------------------------------------------
export {
  createEmbeddingProvider,
  EmbeddingDimensionMismatchError,
  EmbeddingProviderError,
  EmbeddingProviderHttpError,
  EmbeddingProviderShapeError,
  type EmbeddingProvider,
} from "./embedding/provider.js";

// ---------------------------------------------------------------------------
// The batching/retry embedding client (sub-task 3.6) — `embedMany` is what Prompt 4's
// pipeline calls after filtering a batch down to cache misses (sub-task 3.7's
// `getCached`); `classifyEmbeddingError` is exported so a caller building its own
// retry/observability logic around a different provider call can reuse the same
// retriable/non-retriable table this client itself is tested against.
// ---------------------------------------------------------------------------
export {
  classifyEmbeddingError,
  embedMany,
  type EmbedItem,
  type EmbedManyOptions,
  type EmbedManyResult,
  type ErrorClassification,
} from "./embedding/embedding-client.js";

// ---------------------------------------------------------------------------
// The two-layer embedding cache (sub-task 3.7). `apps/worker`'s integration suite
// (tests/integration/embedding-cache.test.ts) is this package's first real consumer.
// ---------------------------------------------------------------------------
export {
  EMBEDDING_CACHE_BATCH_SIZE,
  EMBEDDING_CACHE_REDIS_TTL_SECONDS,
  getCached,
  putCached,
  recordHits,
  type EmbeddingCacheDeps,
  type EmbeddingCacheEntry,
  type RedisLike,
} from "./embedding/embedding-cache.repository.js";
