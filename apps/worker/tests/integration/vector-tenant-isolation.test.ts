import { randomUUID } from "node:crypto";
import {
  deleteByFilePaths,
  deleteByRepository,
  hybridSearch,
  prisma,
  search,
  upsertChunks,
} from "@repo/db";
import type { ChunkUpsertInput, VectorSearchOptions } from "@repo/db";
import { EMBEDDING_DIMENSIONS } from "@repo/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDatabase } from "./db-helpers.js";
import { seedRepository } from "./repository-helpers.js";

/**
 * Phase 05 prompt 2, sub-task 2.6: spec §4 / §14 are emphatic that vector-layer tenant
 * isolation is **asserted, not assumed from the presence of a `WHERE` clause**. Seeded
 * adversarially per the prompt: two projects, two users, two repositories (`repoA`
 * small, `repoB` large), with **byte-identical content** — same file paths, same chunk
 * text, same content hashes — between the two. If tenant isolation is ever broken,
 * identical content makes the leak certain to be caught by an id-based assertion rather
 * than merely likely; every assertion below checks chunk *ids* (globally unique
 * regardless of content), never counts or content alone.
 *
 * Embeddings are a deterministic pseudo-random function of a seed — no real embedding
 * provider is called (`Claude.md` §30 forbids tests depending on live LLM APIs).
 */

// Static guard (spec §13 / plan.md §34.2): VectorSearchOptions.repositoryId cannot be
// optional, enforced at compile time. If a future edit makes it optional, this
// `@ts-expect-error` becomes an unused-suppression error and `pnpm typecheck` fails —
// the cheapest possible regression guard on this invariant.
// @ts-expect-error — repositoryId is intentionally omitted; this must fail to typecheck.
const _missingRepositoryId: VectorSearchOptions = {
  queryEmbedding: [],
  limit: 10,
};
void _missingRepositoryId;

const REPO_A_CHUNK_COUNT = 40;
/** phase-05-vector-search.md §22's own risk framing: "enough chunks in repoB that a
 * top-40 HNSW scan would plausibly be dominated by them." */
const REPO_B_CHUNK_COUNT = 2000;

function makeEmbedding(seed: number): number[] {
  return Array.from(
    { length: EMBEDDING_DIMENSIONS },
    (_, i) => Math.sin(seed * 0.7 + i) * 0.1,
  );
}

function sharedPath(i: number): string {
  return i === 0 ? "src/auth.ts" : `src/file-${i.toString()}.ts`;
}

let repoAId: string;
let repoBId: string;
let repoAChunkIds: Set<string>;
let repoBChunkIds: Set<string>;

beforeAll(async () => {
  await resetDatabase();
  const repoA = await seedRepository();
  const repoB = await seedRepository();
  repoAId = repoA.id;
  repoBId = repoB.id;
  expect(repoA.projectId).not.toBe(repoB.projectId);

  const fileA = await prisma.repositoryFile.create({
    data: {
      repositoryId: repoAId,
      path: "src/auth.ts",
      commitSha: "sha1",
      language: "typescript",
      contentHash: "file-hash-a",
      sizeBytes: 10,
      lineCount: 1,
      classification: "SOURCE",
      indexState: "INDEXED",
    },
  });
  const fileB = await prisma.repositoryFile.create({
    data: {
      repositoryId: repoBId,
      path: "src/auth.ts",
      commitSha: "sha1",
      language: "typescript",
      contentHash: "file-hash-b",
      sizeBytes: 10,
      lineCount: 1,
      classification: "SOURCE",
      indexState: "INDEXED",
    },
  });

  function identicalChunk(
    repositoryId: string,
    fileId: string,
    i: number,
  ): ChunkUpsertInput {
    return {
      id: randomUUID(),
      repositoryId,
      fileId,
      symbolId: null,
      commitSha: "sha1",
      filePath: sharedPath(i),
      packageName: null,
      language: "typescript",
      chunkKind: "SYMBOL",
      startLine: 1,
      endLine: 10,
      content: `export function handler${i.toString()}() { return ${i.toString()}; }`,
      contentHash: `hash-${i.toString()}`,
      symbols: [`handler${i.toString()}`],
      imports: [],
      tokenCount: 12,
      embeddingModel: "test-model",
      embedding: makeEmbedding(i),
    };
  }

  const repoAChunks: ChunkUpsertInput[] = Array.from(
    { length: REPO_A_CHUNK_COUNT },
    (_, i) => identicalChunk(repoAId, fileA.id, i),
  );
  // repoB carries the exact same content/paths/hashes for the first REPO_A_CHUNK_COUNT
  // rows — a different repositoryId is enough to make each row distinct under the
  // (repositoryId, contentHash, startLine, filePath) unique constraint — plus enough
  // additional distinct "noise" chunks to reach REPO_B_CHUNK_COUNT.
  const repoBIdenticalChunks: ChunkUpsertInput[] = Array.from(
    { length: REPO_A_CHUNK_COUNT },
    (_, i) => identicalChunk(repoBId, fileB.id, i),
  );
  const repoBNoiseChunks: ChunkUpsertInput[] = Array.from(
    { length: REPO_B_CHUNK_COUNT - REPO_A_CHUNK_COUNT },
    (_, i) => ({
      id: randomUUID(),
      repositoryId: repoBId,
      fileId: fileB.id,
      symbolId: null,
      commitSha: "sha1",
      filePath: `src/noise-${i.toString()}.ts`,
      packageName: null,
      language: "typescript",
      chunkKind: "SYMBOL",
      startLine: 1,
      endLine: 10,
      content: `export function noise${i.toString()}() { return ${i.toString()}; }`,
      contentHash: `noise-hash-${i.toString()}`,
      symbols: [`noise${i.toString()}`],
      imports: [],
      tokenCount: 12,
      embeddingModel: "test-model",
      embedding: makeEmbedding(i + 10_000),
    }),
  );

  await upsertChunks(repoAChunks);
  await upsertChunks([...repoBIdenticalChunks, ...repoBNoiseChunks]);

  repoAChunkIds = new Set(repoAChunks.map((c) => c.id));
  repoBChunkIds = new Set(
    [...repoBIdenticalChunks, ...repoBNoiseChunks].map((c) => c.id),
  );

  expect(repoAChunkIds.size).toBe(REPO_A_CHUNK_COUNT);
  expect(repoBChunkIds.size).toBe(REPO_B_CHUNK_COUNT);
}, 240_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("vector search tenant isolation — adversarial byte-identical content (spec §4/§14)", () => {
  it("search scoped to repoA returns only repoA chunk ids, non-empty, despite repoB's volume", async () => {
    const results = await search({
      repositoryId: repoAId,
      queryEmbedding: makeEmbedding(0),
      limit: 40,
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(repoAChunkIds.has(r.id)).toBe(true);
      expect(repoBChunkIds.has(r.id)).toBe(false);
    }
  });

  it("hybridSearch scoped to repoA returns only repoA chunk ids, non-empty, despite repoB's volume", async () => {
    const results = await hybridSearch({
      repositoryId: repoAId,
      queryEmbedding: makeEmbedding(0),
      queryText: "handler",
      limit: 40,
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(repoAChunkIds.has(r.id)).toBe(true);
      expect(repoBChunkIds.has(r.id)).toBe(false);
    }
  });

  it("search never crosses the tenant boundary across 20 different query vectors", async () => {
    for (let trial = 0; trial < 20; trial += 1) {
      const results = await search({
        repositoryId: repoAId,
        queryEmbedding: makeEmbedding(trial * 3.1 + 1),
        limit: 40,
      });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(repoBChunkIds.has(r.id)).toBe(false);
      }
    }
  });

  it("hybridSearch never crosses the tenant boundary across 20 different query vectors", async () => {
    for (let trial = 0; trial < 20; trial += 1) {
      const results = await hybridSearch({
        repositoryId: repoAId,
        queryEmbedding: makeEmbedding(trial * 3.1 + 1),
        queryText: "handler",
        limit: 40,
      });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(repoBChunkIds.has(r.id)).toBe(false);
      }
    }
  });

  // Destructive assertions run last, and in this specific order — deleteByFilePaths
  // (partial) before deleteByRepository (full wipe) — since the latter would remove
  // the "src/auth.ts" chunk the former still needs to find in repoA.

  it("deleteByFilePaths(repoA, ['src/auth.ts']) removes only repoA's copy, leaving repoB's identically-named file untouched", async () => {
    const deleted = await deleteByFilePaths(repoAId, ["src/auth.ts"]);
    expect(deleted).toBe(1);

    const remainingA = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "CodeChunk" WHERE "repositoryId" = ${repoAId} AND "filePath" = 'src/auth.ts'
    `;
    expect(remainingA).toHaveLength(0);

    const remainingB = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "CodeChunk" WHERE "repositoryId" = ${repoBId} AND "filePath" = 'src/auth.ts'
    `;
    expect(remainingB).toHaveLength(1);
  });

  it("deleteByRepository(repoA) leaves every repoB chunk intact", async () => {
    const [beforeB] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "CodeChunk" WHERE "repositoryId" = ${repoBId}
    `;

    const deleted = await deleteByRepository(repoAId);
    expect(deleted).toBeGreaterThan(0);

    const remainingA = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "CodeChunk" WHERE "repositoryId" = ${repoAId}
    `;
    expect(remainingA).toHaveLength(0);

    const [afterB] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "CodeChunk" WHERE "repositoryId" = ${repoBId}
    `;
    expect(Number(afterB!.count)).toBe(Number(beforeB!.count));
  });
});
