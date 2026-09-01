import { createLogger } from "@repo/observability";
import {
  EMBEDDING_DIMENSIONS,
  LEXICAL_CANDIDATE_LIMIT,
  VECTOR_CANDIDATE_LIMIT,
} from "@repo/shared";
import type { ChunkKind } from "@repo/shared";
import { prisma } from "../client.js";
import { Prisma } from "../generated/client.js";
import { normalizeVectorScore, rescoreAndRank } from "./hybrid-scorer.js";
import type { HybridCandidate } from "./hybrid-scorer.js";
import type {
  ChunkUpsertInput,
  HybridSearchOptions,
  ScoredChunk,
  VectorSearchOptions,
  VectorStore,
} from "./vector-store.interface.js";

const logger = createLogger("db.pgvector");

/**
 * Phase 05 prompt 2, sub-task 2.2: the pgvector-backed `VectorStore` implementation.
 * Lives in `packages/db/**`, exempt from ESLint Rule B by path (phase-00 §3) — this is
 * the module every `*.repository.ts` caller in `apps/worker`/`apps/api` reaches through
 * `@repo/db`'s barrel (`./index.ts`), never directly.
 *
 * Follows `apps/worker/src/indexing/persistence/code-symbol.repository.ts`'s and
 * `repository-file.repository.ts`'s established batched-`$executeRaw` pattern: every
 * value bound through `Prisma.sql`/`Prisma.join` (never string-interpolated —
 * `plan.md` §35.11), batches run sequentially, never `Promise.all` (the driver
 * adapter's connection pool is shared with everything else the surrounding Inngest step
 * does).
 */

/**
 * `code-symbol.repository.ts`/`repository-file.repository.ts` batch at 1,000 rows per
 * statement; `CodeChunk` rows carry full chunk source text (up to ~1,200 tokens each per
 * phase-05 §10's chunking rule), so a 1,000-row multi-row `VALUES` list here would be
 * meaningfully larger than either of those tables' statements. 500 keeps a single batch
 * statement in a comparable byte-size range while still cutting round trips 500x versus
 * one `INSERT` per chunk.
 */
export const CODE_CHUNK_BATCH_SIZE = 500;

/**
 * Thrown by {@link validateEmbeddingDimensions} before any chunk in the batch reaches
 * Postgres. A dimension mismatch surfaced as a raw Postgres `halfvec` cast error three
 * layers up (inside a batched multi-row statement, with no indication of *which* row)
 * is a bad debugging afternoon — this names the offending chunk id and the actual
 * length instead.
 */
export class VectorDimensionError extends Error {
  constructor(chunkId: string, actualLength: number) {
    super(
      `CodeChunk ${chunkId}: embedding has ${actualLength.toString()} dimensions, expected ${EMBEDDING_DIMENSIONS.toString()}`,
    );
    this.name = "VectorDimensionError";
  }
}

function validateEmbeddingDimensions(chunks: readonly ChunkUpsertInput[]) {
  for (const chunk of chunks) {
    if (
      chunk.embedding !== null &&
      chunk.embedding.length !== EMBEDDING_DIMENSIONS
    ) {
      throw new VectorDimensionError(chunk.id, chunk.embedding.length);
    }
  }
}

/**
 * `halfvec`'s wire format is the string literal `'[0.1,0.2,...]'`, not a JS
 * `number[]` bound as a Postgres array (§2.1 of this prompt's own working notes) — the
 * serialized string is what gets bound as the parameter; `::halfvec(1024)` is static SQL
 * doing the cast, never interpolated with the vector's own values.
 */
function embeddingFragment(embedding: number[] | null): Prisma.Sql {
  if (embedding === null) {
    return Prisma.sql`NULL::halfvec(1024)`;
  }
  const literal = `[${embedding.join(",")}]`;
  return Prisma.sql`${literal}::halfvec(1024)`;
}

/**
 * Upserts `chunks` in batches of {@link CODE_CHUNK_BATCH_SIZE}, sequentially.
 * `ON CONFLICT ("repositoryId","contentHash","startLine","filePath")` — the same unique
 * constraint `schema.prisma` declares — updates the fields that can legitimately change on
 * a re-index (embedding, its model, the commit it was last seen at, the denormalized
 * `symbols`/`imports`, `tokenCount`, and the `symbolId`/`fileId` anchors) and leaves `id`
 * untouched, matching `repository-file.repository.ts`'s own documented reasoning: the
 * existing row keeps its own identity, and the freshly-generated id in a conflicting
 * VALUES row is simply discarded.
 *
 * `symbols`/`imports` (`text[]` columns) bind as plain JS `string[]` parameters with no
 * explicit cast — verified empirically against this table's real column types (see
 * sub-task 2.2's DoD): the `INSERT`'s own explicit column list already tells Postgres to
 * expect `text[]` for these two positions, the same reason `repository-file.repository.ts`
 * never needs casts in its column-list `INSERT` but does need them in its column-list-free
 * `UPDATE ... FROM (VALUES ...)`.
 */
export async function upsertChunks(
  chunks: readonly ChunkUpsertInput[],
): Promise<number> {
  validateEmbeddingDimensions(chunks);

  let affected = 0;
  for (
    let offset = 0;
    offset < chunks.length;
    offset += CODE_CHUNK_BATCH_SIZE
  ) {
    const batch = chunks.slice(offset, offset + CODE_CHUNK_BATCH_SIZE);
    affected += await upsertBatch(batch);
  }
  return affected;
}

async function upsertBatch(
  batch: readonly ChunkUpsertInput[],
): Promise<number> {
  if (batch.length === 0) return 0;

  const now = new Date();
  const rows = Prisma.join(
    batch.map(
      (c) =>
        Prisma.sql`(
          ${c.id},
          ${c.repositoryId},
          ${c.fileId},
          ${c.symbolId},
          ${c.commitSha},
          ${c.filePath},
          ${c.packageName},
          ${c.language},
          ${c.chunkKind},
          ${c.startLine},
          ${c.endLine},
          ${c.content},
          ${c.contentHash},
          ${c.symbols},
          ${c.imports},
          ${c.tokenCount},
          ${c.embeddingModel},
          ${now},
          ${embeddingFragment(c.embedding)}
        )`,
    ),
  );

  return prisma.$executeRaw`
    INSERT INTO "CodeChunk" (
      "id", "repositoryId", "fileId", "symbolId", "commitSha", "filePath",
      "packageName", "language", "chunkKind", "startLine", "endLine", "content",
      "contentHash", "symbols", "imports", "tokenCount", "embeddingModel",
      "createdAt", "embedding"
    )
    VALUES ${rows}
    ON CONFLICT ("repositoryId", "contentHash", "startLine", "filePath") DO UPDATE SET
      "embedding" = EXCLUDED."embedding",
      "embeddingModel" = EXCLUDED."embeddingModel",
      "commitSha" = EXCLUDED."commitSha",
      "content" = EXCLUDED."content",
      "tokenCount" = EXCLUDED."tokenCount",
      "symbols" = EXCLUDED."symbols",
      "imports" = EXCLUDED."imports",
      "symbolId" = EXCLUDED."symbolId",
      "fileId" = EXCLUDED."fileId"
  `;
}

/**
 * `repositoryId` in the `WHERE` clause is not optional even though `filePath` looks
 * sufficient on its own — file paths are not globally unique across repositories, and
 * this is the tenant boundary (phase-05-vector-search.md §13).
 */
export async function deleteByFilePaths(
  repositoryId: string,
  filePaths: readonly string[],
): Promise<number> {
  if (filePaths.length === 0) return 0;
  return prisma.$executeRaw`
    DELETE FROM "CodeChunk"
    WHERE "repositoryId" = ${repositoryId} AND "filePath" = ANY(${filePaths})
  `;
}

/**
 * `ON DELETE CASCADE` from `Repository` (schema.prisma) already removes every `CodeChunk`
 * row when the repository itself is deleted — this method exists for the re-index
 * full-replace path, matching `code-symbol.repository.ts`'s own `deleteByRepository`.
 */
export async function deleteByRepository(
  repositoryId: string,
): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "CodeChunk" WHERE "repositoryId" = ${repositoryId}
  `;
}

// ---------------------------------------------------------------------------
// Sub-task 2.3 — vector-only search
// ---------------------------------------------------------------------------

/**
 * Postgres applies the HNSW index scan *before* the `WHERE "repositoryId" = ...` filter
 * (phase-05-vector-search.md §22's named risk): with many tenants in one table, a
 * top-N index scan can return candidates that all belong to other repositories, leaving
 * zero results for a repository that has thousands of perfectly good chunks. Raising
 * `hnsw.ef_search` (pgvector's HNSW search-time candidate-list size) into the 80–200 band
 * widens that index scan enough that a selective `repositoryId` filter still finds real
 * matches. Exported so Prompt 5's recall test can vary it; see sub-task 2.6's report for
 * the measured value this constant was set to.
 */
export const HNSW_EF_SEARCH_FILTERED = 120;

interface VectorSearchRow {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  chunkKind: string;
  content: string;
  symbols: string[];
  distance: number;
}

/**
 * Builds the optional `commitSha`/`chunkKinds` predicates as composable `Prisma.sql`
 * fragments and joins them with the mandatory `repositoryId`/`embedding IS NOT NULL`
 * predicates — never a conditionally-built SQL string (`plan.md` §35.11).
 */
/**
 * The `commitSha`/`chunkKinds` predicates both `search` and `hybridSearch` accept —
 * built as one AND-prefixed `Prisma.sql` fragment (or `Prisma.empty` when neither is
 * supplied) so a caller can splice it onto the end of any base `WHERE` clause. Never a
 * conditionally-built SQL string (`plan.md` §35.11).
 */
function buildOptionalFilters(
  options: Pick<VectorSearchOptions, "commitSha" | "chunkKinds">,
): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (options.commitSha !== undefined) {
    conditions.push(Prisma.sql`"commitSha" = ${options.commitSha}`);
  }
  if (options.chunkKinds !== undefined && options.chunkKinds.length > 0) {
    conditions.push(Prisma.sql`"chunkKind" = ANY(${options.chunkKinds})`);
  }
  if (conditions.length === 0) return Prisma.empty;
  return Prisma.sql`AND ${Prisma.join(conditions, " AND ")}`;
}

function buildVectorWhereClause(options: VectorSearchOptions): Prisma.Sql {
  return Prisma.sql`"repositoryId" = ${options.repositoryId} AND "embedding" IS NOT NULL ${buildOptionalFilters(options)}`;
}

/**
 * Vector-only similarity search — the unweighted path. `score` is `vectorScore` alone;
 * `graphProximity`/`lexicalScore`/`recencyOrImportance`/`pathAffinity` are set to `0`,
 * not any `hybridSearch` tier constant (e.g. `GRAPH_PROXIMITY.NONE`), because this method
 * never computes any of those signals at all — a nonzero placeholder here would
 * misleadingly imply a real signal was measured. Populated only so both `search` and
 * `hybridSearch` return the same `ScoredChunk` shape; use `hybridSearch` (sub-task 2.5)
 * for the real, weighted retrieval path.
 *
 * Runs inside an interactive transaction so `SET LOCAL hnsw.ef_search` (only valid for
 * the lifetime of a transaction) applies to the search query that follows it — verified
 * empirically that `SET LOCAL` accepts no bind parameter (`syntax error at or near
 * "$1"`), so the fixed, code-controlled {@link HNSW_EF_SEARCH_FILTERED} constant is
 * spliced in via `Prisma.raw`, never anything request-derived.
 *
 * `ORDER BY "embedding" <=> ...` repeats the raw distance expression rather than
 * referencing the `AS "distance"` alias, and nothing wraps it — both deliberate, so the
 * HNSW index remains usable for the ordering (phase-05-vector-search.md §10/§22).
 */
export async function search(
  options: VectorSearchOptions,
): Promise<ScoredChunk[]> {
  const start = performance.now();
  const literal = `[${options.queryEmbedding.join(",")}]`;
  const whereClause = buildVectorWhereClause(options);

  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL hnsw.ef_search = ${Prisma.raw(String(HNSW_EF_SEARCH_FILTERED))}`;
    return tx.$queryRaw<VectorSearchRow[]>`
      SELECT
        "id",
        "filePath",
        "startLine",
        "endLine",
        "chunkKind",
        "content",
        "symbols",
        "embedding" <=> ${literal}::halfvec(1024) AS "distance"
      FROM "CodeChunk"
      WHERE ${whereClause}
      ORDER BY "embedding" <=> ${literal}::halfvec(1024)
      LIMIT ${options.limit}
    `;
  });

  const results: ScoredChunk[] = rows.map((row) => {
    const vectorScore = normalizeVectorScore(row.distance);
    return {
      id: row.id,
      filePath: row.filePath,
      startLine: row.startLine,
      endLine: row.endLine,
      chunkKind: row.chunkKind as ScoredChunk["chunkKind"],
      content: row.content,
      symbols: row.symbols,
      score: vectorScore,
      vectorScore,
      graphProximity: 0,
      lexicalScore: 0,
      recencyOrImportance: 0,
      pathAffinity: 0,
    };
  });

  // Never log the query embedding or chunk content — content is private repository
  // source (phase-05-vector-search.md §20).
  logger.debug("vector search", {
    repositoryId: options.repositoryId,
    limit: options.limit,
    efSearch: HNSW_EF_SEARCH_FILTERED,
    resultCount: results.length,
    elapsedMs: performance.now() - start,
  });

  return results;
}

// ---------------------------------------------------------------------------
// Sub-task 2.5 — hybrid (vector + lexical) search
// ---------------------------------------------------------------------------

interface HybridSearchRow {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  chunkKind: string;
  content: string;
  symbols: string[];
  packageName: string | null;
  distance: number | null;
  tsRank: number | null;
  inboundEdgeCount: number;
  isExported: boolean;
}

/**
 * Spec §10's retrieval shape: top-{@link VECTOR_CANDIDATE_LIMIT} by vector similarity,
 * top-{@link LEXICAL_CANDIDATE_LIMIT} by lexical rank, unioned by chunk id in a single
 * SQL statement (a `FULL OUTER JOIN` between the two CTEs, not two separate round trips
 * merged in the application) — the concrete payoff of keeping vectors in Postgres
 * (`plan.md` §1.3 change ①). A chunk present in both candidate sets produces exactly one
 * merged row (both its `distance` and its `tsRank` populated), never a duplicate.
 *
 * The SQL computes only raw signals — `distance`, `tsRank`, `inboundEdgeCount`,
 * `isExported` — and hands them to `rescoreAndRank` (sub-task 2.4) for the weighted
 * scoring; the weighted sum itself is never computed in SQL, which would make the
 * formula untestable and untunable (spec §20's stated purpose for logging it at all).
 *
 * `websearch_to_tsquery('english', ...)` — not `to_tsquery` — because it never throws
 * on arbitrary user text (spaces, punctuation, operators), which the debug-search
 * panel passes straight through. An empty or stopword-only query text makes it return
 * an empty tsquery that matches nothing; the lexical CTE then contributes zero rows,
 * and the `FULL OUTER JOIN` degrades to exactly the vector CTE's own candidates — no
 * special-casing needed, verified by this sub-task's own integration test.
 *
 * `websearch_to_tsquery`'s query text is `queryText` plus any `changedSymbolNames`
 * (space-joined into one string) — `HybridSearchOptions` documents `changedSymbolNames`
 * as "Phase 08 supplies these," and folding them into the same lexical query (rather
 * than a second `websearch_to_tsquery` call) keeps this a single full-text predicate
 * `ts_rank` can score uniformly.
 *
 * `packageName` for the path-affinity term is read from the joined `RepositoryFile`
 * row, not `CodeChunk`'s own denormalized `packageName` column — deliberately: this
 * store's `upsertChunks` `ON CONFLICT DO UPDATE SET` clause (sub-task 2.2) does not
 * refresh `CodeChunk.packageName` on a content-unchanged re-index, so it can go stale
 * after a repository's package layout changes; `RepositoryFile.packageName` is Phase
 * 04's continuously-refreshed, authoritative source
 * (`repository-file.repository.ts`'s own header comment). `isExported` is read from
 * the joined `CodeSymbol` row via `CodeChunk.symbolId`, defaulting to `false` when the
 * chunk has no symbol (a `FILE_HEADER`/`NEIGHBORHOOD`/`WINDOW` chunk structurally
 * cannot be "exported" in the `CodeSymbol` sense).
 *
 * `HybridSearchOptions` (sub-task 2.1) carries no reference file path — pathAffinity
 * is therefore `PATH_AFFINITY_TIERS.NO_REFERENCE` for every candidate in this phase;
 * Phase 08, the first caller with a real "changed file" to compare against, is where
 * that term starts differentiating results (see `hybrid-scorer.ts`'s own comment on
 * this constant).
 *
 * Same transaction + `SET LOCAL hnsw.ef_search` as `search` (sub-task 2.3), for the
 * identical reason: the vector CTE's `ORDER BY ... LIMIT` needs the widened candidate
 * list under a selective `repositoryId` filter.
 */
export async function hybridSearch(
  options: HybridSearchOptions,
): Promise<ScoredChunk[]> {
  const start = performance.now();
  const literal = `[${options.queryEmbedding.join(",")}]`;
  const lexicalQueryText = [
    options.queryText,
    ...(options.changedSymbolNames ?? []),
  ]
    .filter((s) => s.length > 0)
    .join(" ");
  const optionalFilters = buildOptionalFilters(options);

  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL hnsw.ef_search = ${Prisma.raw(String(HNSW_EF_SEARCH_FILTERED))}`;
    return tx.$queryRaw<HybridSearchRow[]>`
      WITH vector_candidates AS (
        SELECT
          c.id,
          c."embedding" <=> ${literal}::halfvec(1024) AS distance,
          NULL::real AS "tsRank"
        FROM "CodeChunk" c
        WHERE c."repositoryId" = ${options.repositoryId}
          AND c."embedding" IS NOT NULL
          ${optionalFilters}
        ORDER BY c."embedding" <=> ${literal}::halfvec(1024)
        LIMIT ${VECTOR_CANDIDATE_LIMIT}
      ),
      lexical_candidates AS (
        SELECT
          c.id,
          NULL::double precision AS distance,
          ts_rank(c."tsv", websearch_to_tsquery('english', ${lexicalQueryText})) AS "tsRank"
        FROM "CodeChunk" c
        WHERE c."repositoryId" = ${options.repositoryId}
          AND c."tsv" @@ websearch_to_tsquery('english', ${lexicalQueryText})
          ${optionalFilters}
        ORDER BY ts_rank(c."tsv", websearch_to_tsquery('english', ${lexicalQueryText})) DESC
        LIMIT ${LEXICAL_CANDIDATE_LIMIT}
      ),
      candidates AS (
        SELECT COALESCE(v.id, l.id) AS id, v.distance, l."tsRank"
        FROM vector_candidates v
        FULL OUTER JOIN lexical_candidates l ON v.id = l.id
      )
      SELECT
        c.id,
        c."filePath",
        c."startLine",
        c."endLine",
        c."chunkKind",
        c.content,
        c.symbols,
        rf."packageName" AS "packageName",
        cand.distance,
        cand."tsRank",
        COALESCE(rf."inboundEdgeCount", 0) AS "inboundEdgeCount",
        COALESCE(s."isExported", false) AS "isExported"
      FROM candidates cand
      JOIN "CodeChunk" c ON c.id = cand.id
      LEFT JOIN "RepositoryFile" rf ON rf.id = c."fileId"
      LEFT JOIN "CodeSymbol" s ON s.id = c."symbolId"
    `;
  });

  const candidates: HybridCandidate[] = rows.map((row) => ({
    id: row.id,
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    chunkKind: row.chunkKind as ChunkKind,
    content: row.content,
    symbols: row.symbols,
    packageName: row.packageName,
    distance: row.distance,
    tsRank: row.tsRank,
    inboundEdgeCount: row.inboundEdgeCount,
    isExported: row.isExported,
  }));

  const results = rescoreAndRank(candidates, {
    graphProximityByFilePath: options.graphProximityByFilePath,
    queryFilePath: null,
    queryPackageName: null,
    limit: options.limit,
  });

  // Per spec §20: the full per-chunk score breakdown, by id and location — never chunk
  // content, which is private repository source.
  for (const result of results) {
    logger.debug("hybrid search score breakdown", {
      id: result.id,
      filePath: result.filePath,
      startLine: result.startLine,
      endLine: result.endLine,
      score: result.score,
      vectorScore: result.vectorScore,
      graphProximity: result.graphProximity,
      lexicalScore: result.lexicalScore,
      recencyOrImportance: result.recencyOrImportance,
      pathAffinity: result.pathAffinity,
    });
  }

  logger.debug("hybrid search", {
    repositoryId: options.repositoryId,
    limit: options.limit,
    efSearch: HNSW_EF_SEARCH_FILTERED,
    candidateCount: rows.length,
    resultCount: results.length,
    elapsedMs: performance.now() - start,
  });

  return results;
}

/**
 * The full `VectorStore` implementation, satisfying the interface (sub-task 2.1) now
 * that every method exists. Individual functions remain separately exported (above)
 * so tests can exercise them directly, matching `code-symbol.repository.ts`'s own
 * "export both the object and the functions" convention.
 */
export const pgvectorStore: VectorStore = {
  upsert: upsertChunks,
  search,
  hybridSearch,
  deleteByFilePaths,
  deleteByRepository,
};
