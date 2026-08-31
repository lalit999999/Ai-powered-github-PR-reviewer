import { createLogger } from "@repo/observability";
import { EMBEDDING_DIMENSIONS } from "@repo/shared";
import { prisma } from "../client.js";
import { Prisma } from "../generated/client.js";
import type {
  ChunkUpsertInput,
  ScoredChunk,
  VectorSearchOptions,
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

/**
 * `embedding <=> $1` is pgvector's cosine **distance** (`halfvec_cosine_ops`, the HNSW
 * index's own operator class), range `[0, 2]` — not a similarity, and not bounded to
 * `[0, 1]`. `1 - distance` is the naive conversion a reviewer expects, but it produces
 * negative scores for any distance above 1 (a very dissimilar pair, still a legal
 * `<=>` output) and would silently corrupt the hybrid formula's weighted sum, which
 * assumes every term is in `[0, 1]`. Mapping `[0, 2] -> [1, 0]` instead is the correct
 * affine transform, clamped defensively in case of floating-point overshoot right at the
 * boundary.
 *
 * This mirrors the formula sub-task 2.4's `hybrid-scorer.ts` also defines and unit-tests
 * as `normalizeVectorScore` — duplicated here only until that module exists; sub-task
 * 2.4's own commit removes this copy and imports the pure-module version instead, so the
 * conversion has exactly one definition once both sub-tasks have landed.
 */
function distanceToVectorScore(distance: number): number {
  const score = 1 - distance / 2;
  return Math.min(1, Math.max(0, score));
}

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
function buildVectorWhereClause(options: VectorSearchOptions): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`"repositoryId" = ${options.repositoryId}`,
    Prisma.sql`"embedding" IS NOT NULL`,
  ];
  if (options.commitSha !== undefined) {
    conditions.push(Prisma.sql`"commitSha" = ${options.commitSha}`);
  }
  if (options.chunkKinds !== undefined && options.chunkKinds.length > 0) {
    conditions.push(Prisma.sql`"chunkKind" = ANY(${options.chunkKinds})`);
  }
  return Prisma.join(conditions, " AND ");
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
    const vectorScore = distanceToVectorScore(row.distance);
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

// The `pgvectorStore: VectorStore` object satisfying the full interface is assembled
// once `hybridSearch` (sub-task 2.5) exists alongside these methods in this same file —
// see the bottom of this file after sub-task 2.5.
