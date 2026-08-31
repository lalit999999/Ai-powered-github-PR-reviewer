/**
 * Type-level vocabulary for Phase 05's semantic layer (phase-05-vector-search.md §6/§10,
 * plan.md §12). Lives in `packages/shared`, not an app-local `*.types.ts`, for the same
 * producer/consumer reason `indexing.ts` already does: `apps/worker` writes `CodeChunk`
 * rows while chunking and embedding, and `apps/api` reads the same vocabulary for debug
 * search — the two must not be free to drift apart.
 *
 * `EMBEDDING_DIMENSIONS`, the chunking size constants, and `HYBRID_WEIGHTS` are pinned
 * here for a second, sharper reason beyond drift: the pgvector migration
 * (`packages/db/prisma/migrations/*_vector_search/migration.sql`) hard-codes `halfvec(1024)`
 * in raw SQL that Prisma cannot see, and Prompt 3's chunker/Prompt 2's VectorStore must
 * agree with that number and with each other by construction, not by coincidence of two
 * developers reading the same spec section correctly.
 */

// ---------------------------------------------------------------------------
// CodeChunk.chunkKind
// ---------------------------------------------------------------------------

/**
 * `CodeChunk.chunkKind` is a plain `String` column (packages/db/prisma/schema.prisma),
 * not a Postgres enum — the same `indexState`/`skipReason`/`parseState`/`CodeSymbol.kind`
 * precedent `indexing.ts` already follows, not the `IndexStatus`/`FileClassification`/
 * `DependencyKind` real-enum precedent. §10's chunking rule is the source: every file
 * gets one `FILE_HEADER` chunk; every top-level symbol under 1,200 tokens becomes one
 * `SYMBOL` chunk (larger ones split into `WINDOW`-shaped pieces, see
 * `SPLIT_WINDOW_TOKENS` below); runs of tiny adjacent symbols coalesce into a
 * `NEIGHBORHOOD` chunk; unparseable files fall back to line-based `WINDOW` chunks.
 */
export const CHUNK_KINDS = [
  "FILE_HEADER",
  "SYMBOL",
  "NEIGHBORHOOD",
  "WINDOW",
] as const;
export type ChunkKind = (typeof CHUNK_KINDS)[number];
export function isChunkKind(value: unknown): value is ChunkKind {
  return (
    typeof value === "string" &&
    (CHUNK_KINDS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Embedding vector shape and batching
// ---------------------------------------------------------------------------

/**
 * The dimension pinned in `CodeChunk.embedding`/`EmbeddingCache.embedding`'s
 * `halfvec(1024)` column (§6). Anything that builds or validates a vector before it
 * reaches Postgres reads this constant rather than the literal `1024`, so a future
 * dimension change (a different embedding model) is one edit here plus a migration that
 * changes the column type — not a grep-and-hope across every call site.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/** §10 / plan.md §38.1 item 4: "one [Inngest step] per 96 chunks for embedding." */
export const EMBEDDING_BATCH_SIZE = 96;

// ---------------------------------------------------------------------------
// Chunking size constants (§10 chunking rule)
// ---------------------------------------------------------------------------

/** §10: the `FILE_HEADER` chunk (path, imports, exported signatures, leading docblock)
 * targets 150–300 tokens — "cheap, and what semantic search actually matches 'what does
 * this file do' against." */
export const FILE_HEADER_TARGET_TOKENS_MIN = 150;
export const FILE_HEADER_TARGET_TOKENS_MAX = 300;

/** §10: "every top-level symbol under 1,200 tokens becomes one SYMBOL chunk." A symbol
 * at or above this threshold splits instead — see `SPLIT_WINDOW_TOKENS` below. */
export const SYMBOL_CHUNK_MAX_TOKENS = 1200;

/** §10: "larger symbols split at nested-statement boundaries into ~800-token windows
 * with 15% overlap" — the split-window size. */
export const SPLIT_WINDOW_TOKENS = 800;

/** §10's "15% overlap" for a split symbol's windows, as a fraction of
 * `SPLIT_WINDOW_TOKENS`. */
export const SPLIT_OVERLAP_RATIO = 0.15;

/** §10: "runs of tiny adjacent symbols (<120 tokens) coalesce into a NEIGHBORHOOD
 * chunk" — the per-symbol size below which a symbol is a coalescing candidate rather
 * than its own `SYMBOL` chunk. */
export const NEIGHBORHOOD_MIN_SYMBOL_TOKENS = 120;

/** §10: a coalesced `NEIGHBORHOOD` chunk stops growing at 800 tokens. */
export const NEIGHBORHOOD_MAX_TOKENS = 800;

/** §10: "unparseable files fall back to 60-line windows with 10-line overlap." Line-
 * based, not token-based, because a file that fell back here has no AST to measure
 * tokens against symbol boundaries with. */
export const WINDOW_CHUNK_LINES = 60;
export const WINDOW_OVERLAP_LINES = 10;

// ---------------------------------------------------------------------------
// Hybrid scoring (§10 hybrid scoring formula, plan.md §12.4)
// ---------------------------------------------------------------------------

/**
 * `plan.md` §12.4's hybrid scoring formula, used by `hybridSearch`. These weights are
 * heuristic, not derived — plan.md §15.5: "Log the score breakdown on every retrieved
 * item during development — you'll tune the weights from real reviews, and you can't
 * tune what you didn't log." Every debug-search query is expected to log the full
 * per-chunk breakdown for exactly that reason; do not treat these as final.
 */
export const HYBRID_WEIGHTS = {
  vectorScore: 0.45,
  graphProximity: 0.2,
  lexicalScore: 0.15,
  recencyOrImportance: 0.1,
  pathAffinity: 0.1,
} as const;

/** §10: "1.0 same file, 0.7 direct edge, 0.4 depth-2, 0.1 none" — the graph-proximity
 * multiplier tiers `HYBRID_WEIGHTS.graphProximity` scales. */
export const GRAPH_PROXIMITY = {
  SAME_FILE: 1.0,
  DIRECT_EDGE: 0.7,
  DEPTH_TWO: 0.4,
  NONE: 0.1,
} as const;

/** §10: "Retrieve top-40 by vector similarity and top-20 by BM25, union, re-score." */
export const VECTOR_CANDIDATE_LIMIT = 40;
export const LEXICAL_CANDIDATE_LIMIT = 20;
