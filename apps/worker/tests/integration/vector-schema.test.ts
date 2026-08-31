import { randomUUID } from "node:crypto";
import { prisma } from "@repo/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./db-helpers.js";
import { seedRepository } from "./repository-helpers.js";

/**
 * Phase 05 prompt-1 sub-task 1.8: proves the raw-SQL half of the vector-search migration
 * (packages/db/prisma/migrations/*_vector_search/migration.sql) landed correctly, with
 * real SQL rather than Prisma — `CodeChunk.embedding`/`.tsv` are `Unsupported(...)` in
 * schema.prisma precisely because Prisma's query builder cannot see them, so this suite
 * is the only place in the codebase that can assert their shape at all.
 *
 * `resetDatabase` TRUNCATEs with CASCADE (db-helpers.ts) — `CodeChunk` is not named
 * explicitly in that statement, but Postgres's TRUNCATE ... CASCADE follows the foreign
 * keys to `Repository`/`RepositoryFile`/`CodeSymbol` automatically, so this suite needs
 * no change there.
 */

beforeEach(resetDatabase);
afterAll(async () => {
  await prisma.$disconnect();
});

async function seedRepositoryFile(
  repositoryId: string,
  path: string,
): Promise<string> {
  const file = await prisma.repositoryFile.create({
    data: {
      repositoryId,
      path,
      commitSha: "sha1",
      language: "typescript",
      contentHash: `hash-${path}`,
      sizeBytes: 10,
      lineCount: 1,
      classification: "SOURCE",
      indexState: "INDEXED",
    },
  });
  return file.id;
}

async function seedCodeSymbol(
  repositoryId: string,
  fileId: string,
): Promise<string> {
  const symbol = await prisma.codeSymbol.create({
    data: {
      repositoryId,
      fileId,
      name: "fn",
      kind: "FUNCTION",
      startLine: 1,
      endLine: 2,
      isExported: true,
      complexity: 1,
      commitSha: "sha1",
    },
  });
  return symbol.id;
}

/** A pgvector `[...]` literal of the given dimensionality — every component the same
 * value, since these tests only ever care about shape, never about similarity. */
function halfvecLiteral(dimensions: number): string {
  return `[${Array.from({ length: dimensions }, () => "0.1").join(",")}]`;
}

async function insertChunk(args: {
  id?: string;
  repositoryId: string;
  fileId: string;
  symbolId?: string | null;
  filePath?: string;
  startLine?: number;
  contentHash?: string;
  content?: string;
  embeddingDimensions?: number | null;
}): Promise<string> {
  const id = args.id ?? randomUUID();
  const embeddingLiteral =
    args.embeddingDimensions === null || args.embeddingDimensions === undefined
      ? null
      : halfvecLiteral(args.embeddingDimensions);

  await prisma.$executeRaw`
    INSERT INTO "CodeChunk" (
      "id", "repositoryId", "fileId", "symbolId", "commitSha", "filePath",
      "packageName", "language", "chunkKind", "startLine", "endLine", "content",
      "contentHash", "tokenCount", "embeddingModel", "embedding"
    ) VALUES (
      ${id}, ${args.repositoryId}, ${args.fileId}, ${args.symbolId ?? null},
      'sha1', ${args.filePath ?? "src/index.ts"}, NULL, 'typescript', 'SYMBOL',
      ${args.startLine ?? 1}, ${(args.startLine ?? 1) + 5},
      ${args.content ?? "export function fn() { return 1; }"},
      ${args.contentHash ?? randomUUID()}, 10, 'test-model',
      ${embeddingLiteral}::halfvec(1024)
    )
  `;
  return id;
}

describe("vector-search migration — pgvector extension and CodeChunk shape (§8.2)", () => {
  it("has the vector extension installed at >= 0.7.0", async () => {
    const rows = await prisma.$queryRaw<{ extversion: string }[]>`
      SELECT extversion FROM pg_extension WHERE extname = 'vector';
    `;
    expect(rows).toHaveLength(1);

    const [major, minor] = rows[0]!.extversion.split(".").map(Number);
    const atLeast070 = (major ?? 0) > 0 || (minor ?? 0) >= 7;
    expect(atLeast070).toBe(true);
  });

  it("CodeChunk.embedding is a nullable halfvec column — see docs/decisions/phase-05-log.md's nullable-embedding decision", async () => {
    const rows = await prisma.$queryRaw<
      { data_type: string; udt_name: string; is_nullable: string }[]
    >`
      SELECT data_type, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'CodeChunk' AND column_name = 'embedding';
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.udt_name).toBe("halfvec");
    expect(rows[0]!.is_nullable).toBe("YES");
  });

  it("CodeChunk.tsv is a generated stored tsvector column", async () => {
    const rows = await prisma.$queryRaw<
      {
        udt_name: string;
        is_generated: string;
        generation_expression: string;
      }[]
    >`
      SELECT udt_name, is_generated, generation_expression
      FROM information_schema.columns
      WHERE table_name = 'CodeChunk' AND column_name = 'tsv';
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.udt_name).toBe("tsvector");
    expect(rows[0]!.is_generated).toBe("ALWAYS");
    expect(rows[0]!.generation_expression).toContain("to_tsvector");
  });

  it("has the HNSW, GIN, and partial pending-embedding indexes with the specified parameters", async () => {
    const rows = await prisma.$queryRaw<
      { indexname: string; indexdef: string }[]
    >`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'CodeChunk';
    `;
    const byName = Object.fromEntries(
      rows.map((r) => [r.indexname, r.indexdef]),
    );

    expect(byName["CodeChunk_embedding_hnsw_idx"]).toBeDefined();
    expect(byName["CodeChunk_embedding_hnsw_idx"]).toContain("USING hnsw");
    expect(byName["CodeChunk_embedding_hnsw_idx"]).toContain("m='16'");
    expect(byName["CodeChunk_embedding_hnsw_idx"]).toContain(
      "ef_construction='64'",
    );

    expect(byName["CodeChunk_tsv_gin_idx"]).toBeDefined();
    expect(byName["CodeChunk_tsv_gin_idx"]).toContain("USING gin");

    expect(byName["CodeChunk_pending_embedding_idx"]).toBeDefined();
    expect(byName["CodeChunk_pending_embedding_idx"]).toContain(
      "WHERE (embedding IS NULL)",
    );
  });

  it("accepts a real 1024-dimension halfvec literal", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");

    const id = await insertChunk({
      repositoryId: repo.id,
      fileId,
      embeddingDimensions: 1024,
    });

    const rows = await prisma.$queryRaw<{ dims: number }[]>`
      SELECT vector_dims("embedding"::vector) AS dims
      FROM "CodeChunk" WHERE id = ${id};
    `;
    expect(rows[0]!.dims).toBe(1024);
  });

  it("rejects a 1023-dimension halfvec literal", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");

    await expect(
      insertChunk({ repositoryId: repo.id, fileId, embeddingDimensions: 1023 }),
    ).rejects.toThrow(/dimension/i);
  });

  it("ON DELETE CASCADE: deleting the parent RepositoryFile removes its chunks", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");
    const chunkId = await insertChunk({ repositoryId: repo.id, fileId });

    await prisma.repositoryFile.delete({ where: { id: fileId } });

    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "CodeChunk" WHERE id = ${chunkId};
    `;
    expect(rows).toHaveLength(0);
  });

  it("ON DELETE CASCADE: deleting the parent Repository removes its chunks", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");
    const chunkId = await insertChunk({ repositoryId: repo.id, fileId });

    await prisma.repository.delete({ where: { id: repo.id } });

    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "CodeChunk" WHERE id = ${chunkId};
    `;
    expect(rows).toHaveLength(0);
  });

  it("ON DELETE SET NULL: deleting a CodeSymbol leaves symbolId NULL, not the chunk deleted — Phase 04's graph builder deletes and rebuilds every symbol on each re-parse, and a cascade here would silently destroy embeddings on every re-index", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");
    const symbolId = await seedCodeSymbol(repo.id, fileId);
    const chunkId = await insertChunk({
      repositoryId: repo.id,
      fileId,
      symbolId,
    });

    await prisma.codeSymbol.delete({ where: { id: symbolId } });

    const rows = await prisma.$queryRaw<{ symbolId: string | null }[]>`
      SELECT "symbolId" FROM "CodeChunk" WHERE id = ${chunkId};
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbolId).toBeNull();
  });

  it("rejects a duplicate (repositoryId, contentHash, startLine, filePath)", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");
    const sharedContentHash = randomUUID();

    await insertChunk({
      repositoryId: repo.id,
      fileId,
      filePath: "src/a.ts",
      startLine: 1,
      contentHash: sharedContentHash,
    });

    await expect(
      insertChunk({
        repositoryId: repo.id,
        fileId,
        filePath: "src/a.ts",
        startLine: 1,
        contentHash: sharedContentHash,
      }),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});
