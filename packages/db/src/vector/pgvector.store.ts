import { EMBEDDING_DIMENSIONS } from "@repo/shared";
import { prisma } from "../client.js";
import { Prisma } from "../generated/client.js";
import type { ChunkUpsertInput } from "./vector-store.interface.js";

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

// The `pgvectorStore: VectorStore` object satisfying the full interface is assembled
// once `search` (sub-task 2.3) and `hybridSearch` (sub-task 2.5) exist alongside these
// two methods in this same file — see the bottom of this file after sub-task 2.5.
