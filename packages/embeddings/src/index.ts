/**
 * Public barrel for @repo/embeddings — Phase 05 prompt 3's chunking, embedding, and
 * cache layer, consumed by apps/worker (index-time embedding) and apps/api (query-time
 * embedding for the debug search panel). Populated sub-task by sub-task through this
 * prompt; see docs/decisions/phase-05-log.md, Prompt 3 section, for the final export
 * list and why each symbol is public.
 *
 * `FakeEmbeddingProvider` is deliberately NOT exported here — it lives behind the
 * `./testing` subpath (src/testing.ts) so production code cannot accidentally import a
 * test double.
 */

// Sub-task 3.7 — the two-layer embedding cache. `apps/worker`'s integration suite
// (tests/integration/embedding-cache.test.ts) is this package's first real consumer, so
// these are exported as soon as they exist rather than waiting for sub-task 3.8's final
// barrel pass, which adds the chunking/embedding-client exports still to come.
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
