import { randomUUID } from "node:crypto";
import {
  deleteByFilePaths,
  deleteByRepository,
  hybridSearch,
  prisma,
  search,
  upsertChunks,
  VectorDimensionError,
} from "@repo/db";
import type { ChunkUpsertInput } from "@repo/db";
import { EMBEDDING_DIMENSIONS, HYBRID_WEIGHTS } from "@repo/shared";
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

describe("pgvector.store — search (sub-task 2.3)", () => {
  it("respects limit and orders by ascending distance / descending vectorScore", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");

    // Chunk 0's embedding is identical to the query vector (distance 0, vectorScore 1);
    // each subsequent chunk is a progressively worse match.
    const query = makeEmbedding(0);
    const chunks = Array.from({ length: 10 }, (_, i) =>
      makeChunk({
        repositoryId: repo.id,
        fileId,
        startLine: i,
        contentHash: `hash-${i.toString()}`,
        embedding: i === 0 ? query : makeEmbedding(i * 500),
      }),
    );
    await upsertChunks(chunks);

    const results = await search({
      repositoryId: repo.id,
      queryEmbedding: query,
      limit: 5,
    });

    expect(results).toHaveLength(5);
    expect(results[0]!.id).toBe(chunks[0]!.id);
    expect(results[0]!.vectorScore).toBeCloseTo(1, 5);
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i - 1]!.vectorScore).toBeGreaterThanOrEqual(
        results[i]!.vectorScore,
      );
    }
  });

  it("never returns a chunk with a NULL embedding", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");
    const query = makeEmbedding(0);

    await upsertChunks([
      makeChunk({
        repositoryId: repo.id,
        fileId,
        startLine: 1,
        embedding: query,
      }),
      makeChunk({
        repositoryId: repo.id,
        fileId,
        startLine: 2,
        contentHash: "pending",
        embedding: null,
      }),
    ]);

    const results = await search({
      repositoryId: repo.id,
      queryEmbedding: query,
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.startLine).toBe(1);
  });

  it("filters by commitSha and chunkKinds", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");
    const query = makeEmbedding(0);

    await upsertChunks([
      makeChunk({
        repositoryId: repo.id,
        fileId,
        startLine: 1,
        contentHash: "h1",
        commitSha: "sha-old",
        chunkKind: "SYMBOL",
        embedding: query,
      }),
      makeChunk({
        repositoryId: repo.id,
        fileId,
        startLine: 2,
        contentHash: "h2",
        commitSha: "sha-new",
        chunkKind: "FILE_HEADER",
        embedding: query,
      }),
      makeChunk({
        repositoryId: repo.id,
        fileId,
        startLine: 3,
        contentHash: "h3",
        commitSha: "sha-new",
        chunkKind: "SYMBOL",
        embedding: query,
      }),
    ]);

    const byCommit = await search({
      repositoryId: repo.id,
      queryEmbedding: query,
      limit: 10,
      commitSha: "sha-new",
    });
    expect(byCommit.map((r) => r.startLine).sort()).toEqual([2, 3]);

    const byKind = await search({
      repositoryId: repo.id,
      queryEmbedding: query,
      limit: 10,
      chunkKinds: ["FILE_HEADER"],
    });
    expect(byKind.map((r) => r.startLine)).toEqual([2]);
  });

  it("never returns a chunk from a different repository", async () => {
    const repoA = await seedRepository();
    const repoB = await seedRepository();
    const fileA = await seedRepositoryFile(repoA.id, "src/a.ts");
    const fileB = await seedRepositoryFile(repoB.id, "src/a.ts");
    const query = makeEmbedding(0);

    await upsertChunks([
      makeChunk({ repositoryId: repoA.id, fileId: fileA, embedding: query }),
      makeChunk({ repositoryId: repoB.id, fileId: fileB, embedding: query }),
    ]);

    const results = await search({
      repositoryId: repoA.id,
      queryEmbedding: query,
      limit: 10,
    });
    expect(results).toHaveLength(1);
  });
});

describe("pgvector.store — hybridSearch (sub-task 2.5)", () => {
  it("a chunk present in both the vector and lexical candidate sets appears exactly once", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");
    const query = makeEmbedding(0);

    const bothChunk = makeChunk({
      repositoryId: repo.id,
      fileId,
      startLine: 1,
      contentHash: "both",
      content: "export function uniqueLexicalKeywordZephyr() { return 1; }",
      embedding: query,
    });
    await upsertChunks([bothChunk]);

    const results = await hybridSearch({
      repositoryId: repo.id,
      queryEmbedding: query,
      queryText: "uniqueLexicalKeywordZephyr",
      limit: 10,
    });

    const matches = results.filter((r) => r.id === bothChunk.id);
    expect(matches).toHaveLength(1);
  });

  it("a chunk matching only lexically (poor semantic match) still surfaces", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");
    const query = makeEmbedding(0);
    // Worst possible cosine distance from the query (distance 2) — guaranteed to be
    // excluded from the vector CTE's top-40 as long as enough better-matching filler
    // chunks exist.
    const negated = query.map((v) => -v);

    const fillers = Array.from({ length: 45 }, (_, i) =>
      makeChunk({
        repositoryId: repo.id,
        fileId,
        startLine: 100 + i,
        contentHash: `filler-${i.toString()}`,
        embedding: makeEmbedding(i + 1),
      }),
    );
    const lexicalOnlyChunk = makeChunk({
      repositoryId: repo.id,
      fileId,
      startLine: 1,
      contentHash: "lexical-only",
      content:
        "export function veryDistinctiveAuthMiddlewareKeyword() { return 1; }",
      embedding: negated,
    });
    await upsertChunks([...fillers, lexicalOnlyChunk]);

    const results = await hybridSearch({
      repositoryId: repo.id,
      queryEmbedding: query,
      queryText: "veryDistinctiveAuthMiddlewareKeyword",
      limit: 50,
    });

    expect(results.some((r) => r.id === lexicalOnlyChunk.id)).toBe(true);
  });

  it("an empty queryText works — the vector side still returns candidates", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");
    const query = makeEmbedding(0);

    await upsertChunks([
      makeChunk({ repositoryId: repo.id, fileId, embedding: query }),
    ]);

    const results = await hybridSearch({
      repositoryId: repo.id,
      queryEmbedding: query,
      queryText: "",
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
  });

  it("respects limit", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");
    const query = makeEmbedding(0);

    const chunks = Array.from({ length: 10 }, (_, i) =>
      makeChunk({
        repositoryId: repo.id,
        fileId,
        startLine: i,
        contentHash: `hs-${i.toString()}`,
        embedding: makeEmbedding(i),
      }),
    );
    await upsertChunks(chunks);

    const results = await hybridSearch({
      repositoryId: repo.id,
      queryEmbedding: query,
      queryText: "",
      limit: 3,
    });
    expect(results).toHaveLength(3);
  });

  it("every result has all five score components populated, and score equals their weighted sum", async () => {
    const repo = await seedRepository();
    const fileId = await seedRepositoryFile(repo.id, "src/a.ts");
    const query = makeEmbedding(0);

    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk({
        repositoryId: repo.id,
        fileId,
        startLine: i,
        contentHash: `arith-${i.toString()}`,
        content: `export function fn${i.toString()}() { return authKeyword; }`,
        embedding: makeEmbedding(i),
      }),
    );
    await upsertChunks(chunks);

    const results = await hybridSearch({
      repositoryId: repo.id,
      queryEmbedding: query,
      queryText: "authKeyword",
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.vectorScore).toBe("number");
      expect(typeof r.graphProximity).toBe("number");
      expect(typeof r.lexicalScore).toBe("number");
      expect(typeof r.recencyOrImportance).toBe("number");
      expect(typeof r.pathAffinity).toBe("number");
      const expectedScore =
        HYBRID_WEIGHTS.vectorScore * r.vectorScore +
        HYBRID_WEIGHTS.graphProximity * r.graphProximity +
        HYBRID_WEIGHTS.lexicalScore * r.lexicalScore +
        HYBRID_WEIGHTS.recencyOrImportance * r.recencyOrImportance +
        HYBRID_WEIGHTS.pathAffinity * r.pathAffinity;
      expect(r.score).toBeCloseTo(expectedScore, 10);
    }
  });

  it("never returns a chunk from a different repository", async () => {
    const repoA = await seedRepository();
    const repoB = await seedRepository();
    const fileA = await seedRepositoryFile(repoA.id, "src/auth.ts");
    const fileB = await seedRepositoryFile(repoB.id, "src/auth.ts");
    const query = makeEmbedding(0);

    await upsertChunks([
      makeChunk({
        repositoryId: repoA.id,
        fileId: fileA,
        content: "export function authHandler() {}",
        embedding: query,
      }),
      makeChunk({
        repositoryId: repoB.id,
        fileId: fileB,
        content: "export function authHandler() {}",
        embedding: query,
      }),
    ]);

    const results = await hybridSearch({
      repositoryId: repoA.id,
      queryEmbedding: query,
      queryText: "authHandler",
      limit: 10,
    });
    expect(results).toHaveLength(1);
  });
});
