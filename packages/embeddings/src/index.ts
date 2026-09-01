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
export {};
