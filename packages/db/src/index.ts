export { prisma } from "./client.js";
export { authAdapter } from "./auth-adapter.js";

// The raw-SQL composition namespace (`Prisma.sql` / `.join` / `.raw` / `.empty`) — the
// only sanctioned way to build a parameterized `$executeRaw`/`$queryRaw` query
// (plan.md §35.11 forbids string interpolation into SQL). Imported from
// `./generated/client.js`, not `./client.js`: the latter is this package's hand-written
// wrapper that constructs the real `PrismaClient` instance and throws at import time if
// `DATABASE_URL` is unset (`packages/db/src/client.ts`) — a deliberate fail-fast for a
// real connection. `./generated/client.js` is Prisma's own generated module; importing
// it touches no environment variable and opens no connection, so re-exporting `Prisma`
// from it adds no new footgun for a consumer that only wants the query-building helpers.
export { Prisma } from "./generated/client.js";

// Phase 05 prompt 2: the pgvector `VectorStore` implementation — docs/vector-search.md
// has the full contract and the pgvector-vs-Qdrant trade-off; this is only the "why is
// each symbol public" note.
//
// `pgvectorStore` is the object Phase 08's Context Engine and the debug-search panel
// (Prompt 5) import to actually search — the single object satisfying the full
// `VectorStore` interface. The individual functions (`upsertChunks`, `search`,
// `hybridSearch`, `deleteByFilePaths`, `deleteByRepository`) are ALSO exported
// separately, matching `code-symbol.repository.ts`'s own "export both the object and
// the functions" convention — this repository's own integration tests
// (`apps/worker/tests/integration/vector-*.test.ts`) call them directly, and every
// `apps/worker`/`apps/api` consumer reaches `packages/db/src/vector/**` only through
// this barrel (the package's `exports` map has a single `"."` entry).
export {
  deleteByFilePaths,
  deleteByRepository,
  hybridSearch,
  HNSW_EF_SEARCH_FILTERED,
  pgvectorStore,
  search,
  upsertChunks,
  VectorDimensionError,
} from "./vector/pgvector.store.js";
// The interface itself and its types (sub-task 2.1) — the contract Prompt 3's chunker
// (`ChunkUpsertInput`), every search caller (`VectorSearchOptions`/
// `HybridSearchOptions`), and every result consumer (`ScoredChunk`) is written against.
export type { VectorStore } from "./vector/vector-store.interface.js";
export type {
  ChunkUpsertInput,
  HybridSearchOptions,
  ScoredChunk,
  VectorSearchOptions,
} from "./vector/vector-store.interface.js";

// The hybrid scorer (sub-task 2.4) — pure functions Phase 08/09 will call directly to
// re-score or tune outside of a live `hybridSearch` call (`plan.md` §15.5: weights get
// tuned from real review data), and that the debug-search panel (Prompt 5) uses to
// explain a score breakdown in its own UI without re-deriving the formula.
export {
  graphProximityFor,
  normalizeLexicalScore,
  normalizeVectorScore,
  PATH_AFFINITY_TIERS,
  pathAffinity,
  recencyOrImportance,
  rescoreAndRank,
  scoreChunk,
} from "./vector/hybrid-scorer.js";
export type {
  HybridCandidate,
  HybridScoreComponents,
  RecencyImportanceInput,
  RescoreContext,
} from "./vector/hybrid-scorer.js";
