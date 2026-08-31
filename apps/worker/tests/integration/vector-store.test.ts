import { randomUUID } from "node:crypto";
import {
  deleteByFilePaths,
  deleteByRepository,
  prisma,
  upsertChunks,
  VectorDimensionError,
} from "@repo/db";
import type { ChunkUpsertInput } from "@repo/db";
import { EMBEDDING_DIMENSIONS } from "@repo/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./db-helpers.js";
import { seedRepository } from "./repository-helpers.js";

/**
 * Phase 05 prompt 2, sub-task 2.2 (extended by 2.3/2.5): integration coverage for the
 * pgvector `VectorStore` implementation (`packages/db/src/vector/pgvector.store.ts`).
 * Lives in `apps/worker`'s Testcontainers harness, the same reasoning
 * `vector-schema.test.ts` (Phase 05 prompt 1) already gives — this is the only place in
 * the codebase with a real `pgvector/pgvector:pg16` Postgres to assert raw-SQL behavior
 * against.
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

function makeEmbedding(seed: number): number[] {
  return Array.from(
    { length: EMBEDDING_DIMENSIONS },
    (_, i) => Math.sin(seed + i) * 0.01,
  );
}

function makeChunk(
  overrides: Partial<ChunkUpsertInput> & {
    repositoryId: string;
    fileId: string;
  },
): ChunkUpsertInput {
  return {
    id: randomUUID(),
    symbolId: null,
    commitSha: "sha1",
    filePath: "src/index.ts",
    packageName: null,
    language: "typescript",
    chunkKind: "SYMBOL",
    startLine: 1,
    endLine: 10,
    content: "export function fn() { return 1; }",
    contentHash: randomUUID(),
    symbols: ["fn"],
    imports: ["node:crypto"],
    tokenCount: 12,
    embeddingModel: "test-model",
    embedding: makeEmbedding(1),
    ...overrides,
  };
}

describe("pgvector.store — upsertChunks", () => {
  it("upserts a 300-chunk batch, larger than one CODE_CHUNK_BATCH_SIZE batch", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");

    const chunks = Array.from({ length: 300 }, (_, i) =>
      makeChunk({
        repositoryId: repo.id,
        fileId,
        filePath: "src/a.ts",
        startLine: i,
        contentHash: `hash-${i.toString()}`,
        embedding: makeEmbedding(i),
      }),
    );

    const affected = await upsertChunks(chunks);
    expect(affected).toBe(300);

    const count = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "CodeChunk" WHERE "repositoryId" = ${repo.id}
    `;
    expect(Number(count[0]!.count)).toBe(300);
  });

  it("re-upserting the same rows updates in place rather than duplicating, and the embedding changes", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");

    const chunks = Array.from({ length: 300 }, (_, i) =>
      makeChunk({
        repositoryId: repo.id,
        fileId,
        filePath: "src/a.ts",
        startLine: i,
        contentHash: `hash-${i.toString()}`,
        embedding: makeEmbedding(i),
      }),
    );
    await upsertChunks(chunks);

    const updated = chunks.map((c) => ({
      ...c,
      embedding: makeEmbedding(c.startLine + 1000),
    }));
    await upsertChunks(updated);

    const count = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "CodeChunk" WHERE "repositoryId" = ${repo.id}
    `;
    expect(Number(count[0]!.count)).toBe(300);

    const [row] = await prisma.$queryRaw<{ embedding: string }[]>`
      SELECT "embedding"::text AS embedding FROM "CodeChunk"
      WHERE "repositoryId" = ${repo.id} AND "startLine" = 0
    `;
    const originalLiteral = `[${makeEmbedding(0).join(",")}]`;
    expect(row!.embedding).not.toBe(originalLiteral);
  });

  it("inserts a null-embedding chunk fine (the PARTIAL/resume path)", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");

    await upsertChunks([
      makeChunk({ repositoryId: repo.id, fileId, embedding: null }),
    ]);

    const rows = await prisma.$queryRaw<{ embedding: string | null }[]>`
      SELECT "embedding" FROM "CodeChunk" WHERE "repositoryId" = ${repo.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.embedding).toBeNull();
  });

  it("rejects a 1023-dimension vector before reaching Postgres, naming the chunk id", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");
    const badChunk = makeChunk({
      repositoryId: repo.id,
      fileId,
      embedding: makeEmbedding(1).slice(0, 1023),
    });

    await expect(upsertChunks([badChunk])).rejects.toThrow(
      VectorDimensionError,
    );
    await expect(upsertChunks([badChunk])).rejects.toThrow(
      new RegExp(`${badChunk.id}.*1023`),
    );

    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "CodeChunk" WHERE "repositoryId" = ${repo.id}
    `;
    expect(rows).toHaveLength(0);
  });

  it("round-trips symbols/imports text[] columns without an explicit cast", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");
    const chunk = makeChunk({
      repositoryId: repo.id,
      fileId,
      symbols: ["fn", "Widget", "useThing"],
      imports: ["react", "node:crypto"],
    });

    await upsertChunks([chunk]);

    const rows = await prisma.$queryRaw<
      { symbols: string[]; imports: string[] }[]
    >`
      SELECT "symbols", "imports" FROM "CodeChunk" WHERE id = ${chunk.id}
    `;
    expect(rows[0]!.symbols).toEqual(["fn", "Widget", "useThing"]);
    expect(rows[0]!.imports).toEqual(["react", "node:crypto"]);
  });
});

describe("pgvector.store — deleteByFilePaths / deleteByRepository", () => {
  it("deleteByFilePaths removes only the named paths in the named repository, leaving an identically-named path in a second repository untouched", async () => {
    const repoA = await seedRepository();
    const repoB = await seedRepository();
    const fileA = await seedRepositoryFile(repoA.id, "src/auth.ts");
    const fileB = await seedRepositoryFile(repoB.id, "src/auth.ts");

    await upsertChunks([
      makeChunk({
        repositoryId: repoA.id,
        fileId: fileA,
        filePath: "src/auth.ts",
      }),
      makeChunk({
        repositoryId: repoB.id,
        fileId: fileB,
        filePath: "src/auth.ts",
      }),
    ]);

    const deleted = await deleteByFilePaths(repoA.id, ["src/auth.ts"]);
    expect(deleted).toBe(1);

    const remainingA = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "CodeChunk" WHERE "repositoryId" = ${repoA.id}
    `;
    expect(remainingA).toHaveLength(0);

    const remainingB = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "CodeChunk" WHERE "repositoryId" = ${repoB.id}
    `;
    expect(remainingB).toHaveLength(1);
  });

  it("deleteByRepository removes every chunk for that repository only", async () => {
    const repoA = await seedRepository();
    const repoB = await seedRepository();
    const fileA = await seedRepositoryFile(repoA.id, "src/a.ts");
    const fileB = await seedRepositoryFile(repoB.id, "src/b.ts");

    await upsertChunks([
      makeChunk({ repositoryId: repoA.id, fileId: fileA }),
      makeChunk({ repositoryId: repoB.id, fileId: fileB }),
    ]);

    const deleted = await deleteByRepository(repoA.id);
    expect(deleted).toBe(1);

    const remainingA = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "CodeChunk" WHERE "repositoryId" = ${repoA.id}
    `;
    expect(remainingA).toHaveLength(0);

    const remainingB = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "CodeChunk" WHERE "repositoryId" = ${repoB.id}
    `;
    expect(remainingB).toHaveLength(1);
  });
});
