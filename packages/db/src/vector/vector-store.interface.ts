import type { ChunkKind } from "@repo/shared";

/**
 * Phase 05 prompt 2, sub-task 2.1: the contract between the indexing pipeline
 * (`apps/worker`) and the retrieval callers (`apps/api`'s debug-search panel now,
 * Phase 08's Context Engine later) and the pgvector-vs-Qdrant trade-off, written down
 * once so a future migration is a swap of the implementation behind this interface, not
 * a rewrite of every caller (phase-05-vector-search.md §16).
 *
 * ## Why pgvector for the MVP
 *
 * `plan.md` §1.3 change ① / Decision D1: a second stateful system (Qdrant) buys nothing
 * at MVP scale (`plan.md` §42.1: ~30 repos / ~4M vectors at the 10-user stage) and
 * introduces a real correctness risk — vectors pointing at a commit Postgres has already
 * rolled back, because two systems with no shared transaction have no transactional
 * consistency with each other. Keeping chunks in Postgres means:
 *
 * - `CodeChunk` is a normal table with real foreign keys to `Repository` and
 *   `RepositoryFile` — deletes are `ON DELETE CASCADE`, not a distributed cleanup job a
 *   Qdrant implementation would need a reconciler to keep honest.
 * - Tenant isolation is a `WHERE "repositoryId" = $1` clause on the same query that reads
 *   the vectors, not a second isolation model (a Qdrant payload filter) that has to be
 *   proven to agree with Postgres's row-level truth.
 * - Hybrid retrieval (vector + lexical) is one SQL statement (sub-task 2.5's CTE) instead
 *   of two round trips to two systems that then have to be merged and re-scored in the
 *   caller — the concrete payoff `plan.md` §1.3 change ① argues for.
 *
 * ## The scale threshold for revisiting this
 *
 * `plan.md` §42.1 names ~30–50M vectors (the "1,000 users" growth stage, where Qdrant
 * migration is the named trigger) as the point pgvector's filtered-recall and index-build
 * cost stop being the cheaper option. Below that, `plan.md` §42.2 item 3 names
 * partitioning `CodeChunk` by `repositoryId` hash (at ~200 repositories, see this
 * interface's `search`/`hybridSearch` implementations for the `ef_search` mitigation used
 * until then) as the intermediate step — not built in this phase, but nothing in this
 * interface or its implementation may foreclose it: no global unique constraint or
 * cross-partition foreign key that a hash-partitioned `CodeChunk` could not carry.
 *
 * ## What a Qdrant implementation of this interface would have to reproduce
 *
 * 1. **`repositoryId` filtering** — a Qdrant payload index on `repositoryId`, queried with
 *    a mandatory filter, mirroring this interface's `VectorSearchOptions.repositoryId`
 *    being a required (never optional) field.
 * 2. **The union-then-rescore retrieval shape** (`hybridSearch`) — Qdrant has no native
 *    lexical/BM25 index over the same collection the way Postgres's GIN index sits next
 *    to the HNSW index on the same table, so a Qdrant-backed `hybridSearch` would need a
 *    second lexical store (e.g. a separate text-search service) and a real two-system
 *    union, exactly the round-trip cost pgvector avoids today.
 * 3. **Transactional consistency with `RepositoryFile`, for free** — pgvector chunks are
 *    written in the same Postgres instance (even the same transaction, if the caller
 *    chooses) as the `RepositoryFile`/`CodeSymbol` rows they're derived from. A Qdrant
 *    implementation would need an explicit reconciler process to detect and repair drift
 *    between the two stores — a new failure mode this interface's pgvector implementation
 *    does not have.
 * 4. **Cascade deletes** — `deleteByFilePaths`/`deleteByRepository` are a single
 *    `DELETE ... WHERE` in Postgres; Qdrant would need its own delete-by-filter call kept
 *    in sync with Postgres's `RepositoryFile`/`Repository` deletes by application code,
 *    not the database's own foreign-key cascade.
 *
 * ## Why `ScoredChunk` carries every score component separately
 *
 * `plan.md` §15.5: "Log the score breakdown on every retrieved item during development —
 * you'll tune the weights from real reviews, and you can't tune what you didn't log."
 * `ScoredChunk` therefore never collapses `vectorScore`/`graphProximity`/`lexicalScore`/
 * `recencyOrImportance`/`pathAffinity` into just `score` — every caller that logs a
 * `ScoredChunk` (the debug-search panel now, Phase 08/09's tuning work later) gets the
 * full breakdown for free, by construction, rather than needing a second code path that
 * remembers to log the components.
 *
 * ## Graph proximity is a caller-supplied input, not something this store computes
 *
 * `hybridSearch` does not query `CodeDependency` itself. `apps/api` cannot import from
 * `apps/worker` (ESLint Rule C) and `packages/db` must not import from either — the only
 * module with both graph access (`apps/worker`'s
 * `indexing/graph/graph-queries.repository.ts`, `getInboundCallers`/
 * `getFilesImportingFile`) and a reason to call `hybridSearch` is whoever is doing the
 * retrieval, so `graphProximityByFilePath` is a plain, pre-computed
 * `Record<filePath, proximity>` the caller passes in. This keeps `VectorStore` a pure
 * storage-and-retrieval abstraction with zero knowledge of `CodeDependency`, which is
 * also precisely what makes a future Qdrant implementation (point 2 above) not also have
 * to reproduce graph traversal. When a caller supplies nothing (or an empty map), every
 * candidate falls back to `GRAPH_PROXIMITY.NONE` (0.1) — a flat, uninformative signal, not
 * a bug: with no graph input, the other four terms alone decide the ranking.
 */

export interface ChunkUpsertInput {
  /**
   * Caller-generated, following `CodeSymbolInsertInput.id`'s precedent
   * (`apps/worker/src/indexing/persistence/code-symbol.repository.ts`):
   * `schema.prisma`'s `@default(uuid())` is Prisma-client-side codegen, not a Postgres
   * `DEFAULT` — confirmed by this migration's own SQL (`"id" TEXT NOT NULL`, nothing
   * else) — so a raw multi-row `INSERT` must supply the id itself rather than relying on
   * a database-side default that does not exist.
   */
  id: string;
  repositoryId: string;
  fileId: string;
  symbolId: string | null;
  commitSha: string;
  filePath: string;
  packageName: string | null;
  language: string;
  chunkKind: ChunkKind;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  symbols: string[];
  imports: string[];
  tokenCount: number;
  embeddingModel: string;
  /** null when the chunk is persisted ahead of embedding — the PARTIAL/resume path
   * (phase-05-vector-search.md §4 Reliability / §8 Failure behavior). */
  embedding: number[] | null;
}

export interface VectorSearchOptions {
  /**
   * MANDATORY. Not optional, no default, no "if undefined, search everything" branch.
   * phase-05-vector-search.md §13 / `plan.md` §34.2: this is the vector-layer half of
   * tenant isolation, and it is enforced by this field being required in the TypeScript
   * signature — not by convention, and not by every caller remembering to pass it.
   */
  repositoryId: string;
  queryEmbedding: number[];
  limit: number;
  commitSha?: string;
  chunkKinds?: readonly ChunkKind[];
}

export interface HybridSearchOptions extends VectorSearchOptions {
  queryText: string;
  /** filePath -> proximity in [0,1]. See this file's header comment for why this is an
   * input rather than something the store computes. */
  graphProximityByFilePath?: Readonly<Record<string, number>>;
  /** Symbol names from the changed code, for the lexical term. Phase 08 supplies these. */
  changedSymbolNames?: readonly string[];
}

export interface ScoredChunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  chunkKind: ChunkKind;
  content: string;
  symbols: string[];
  score: number;
  vectorScore: number;
  graphProximity: number;
  lexicalScore: number;
  recencyOrImportance: number;
  pathAffinity: number;
}

export interface VectorStore {
  upsert(chunks: readonly ChunkUpsertInput[]): Promise<number>;
  search(options: VectorSearchOptions): Promise<ScoredChunk[]>;
  hybridSearch(options: HybridSearchOptions): Promise<ScoredChunk[]>;
  deleteByFilePaths(
    repositoryId: string,
    filePaths: readonly string[],
  ): Promise<number>;
  deleteByRepository(repositoryId: string): Promise<number>;
}
