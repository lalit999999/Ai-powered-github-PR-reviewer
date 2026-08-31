import { randomUUID } from "node:crypto";
import { prisma, search, upsertChunks } from "@repo/db";
import type { ChunkUpsertInput } from "@repo/db";
import { EMBEDDING_DIMENSIONS } from "@repo/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDatabase } from "./db-helpers.js";
import { seedRepository } from "./repository-helpers.js";

/**
 * Phase 05 prompt 2, sub-task 2.3: `plan.md` §41.3's own framing (already quoted by
 * `graph-query-plans.test.ts`) — "a test that fails if a query plan degrades to a seq
 * scan is worth ten load tests." `vector-store.test.ts`'s own `search` tests run against
 * a handful of rows, small enough that Postgres *correctly* prefers a sequential scan —
 * which would make an index-usage assertion pass for the wrong reason.
 *
 * **Measured, not guessed**: a single repository's own row count is what the planner
 * weighs against the HNSW index here, because `WHERE "repositoryId" = ...` matches 100%
 * of the table in this single-tenant setup, and Postgres compares "fetch every matching
 * row via the repositoryId index/seq scan, then sort in memory" against "walk the HNSW
 * graph in distance order, filtering as you go." The first plan's cost scales with the
 * matching-row count; a naive "a few thousand rows" (the seed size `graph-query-plans.
 * test.ts` uses for its own, differently-shaped query) turned out to still be cheap
 * enough to sort directly — verified empirically against this exact Postgres/pgvector
 * build: 3,000 rows chose a Bitmap Heap Scan + in-memory sort; 20,000 and 30,000 rows
 * still preferred a full Seq Scan + sort; the plan only flips to
 * `Index Scan using "CodeChunk_embedding_hnsw_idx"` somewhere between 30,000 and 40,000
 * rows. This file seeds **50,000** — comfortably above that measured crossover — rather
 * than the smaller number a reader might otherwise assume suffices.
 *
 * Seeded once in `beforeAll` (not per-`it`) — seeding 50,000 embeddings is the expensive
 * part of this file; every `it` below only reads the result.
 */

const CHUNK_COUNT = 50_000;

interface ExplainRow {
  "QUERY PLAN": [{ Plan: PlanNode; "Execution Time": number }];
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Total Time"?: number;
  Plans?: PlanNode[];
}

function flattenPlan(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

function printPlan(label: string, plan: PlanNode): void {
  console.log(`\n--- EXPLAIN ANALYZE: ${label} ---`);
  console.log(JSON.stringify(plan, null, 1));
}

/** Deterministic pseudo-random unit-scale embedding — cheap, reproducible, and never a
 * call to a real embedding provider (`Claude.md` §30 forbids live-LLM-API test
 * dependencies). */
function makeEmbedding(seed: number): number[] {
  return Array.from(
    { length: EMBEDDING_DIMENSIONS },
    (_, i) => Math.sin(seed * 0.017 + i) * 0.1,
  );
}

let repositoryId: string;
let fileId: string;
const queryEmbedding = makeEmbedding(0);

beforeAll(async () => {
  await resetDatabase();
  const repo = await seedRepository();
  repositoryId = repo.id;
  const file = await prisma.repositoryFile.create({
    data: {
      repositoryId,
      path: "src/scale.ts",
      commitSha: "sha1",
      language: "typescript",
      contentHash: "hash-scale",
      sizeBytes: 10,
      lineCount: 1,
      classification: "SOURCE",
      indexState: "INDEXED",
    },
  });
  fileId = file.id;

  const chunks: ChunkUpsertInput[] = Array.from(
    { length: CHUNK_COUNT },
    (_, i) => ({
      id: randomUUID(),
      repositoryId,
      fileId,
      symbolId: null,
      commitSha: "sha1",
      filePath: `src/pkg-${(i % 20).toString()}/file-${i.toString()}.ts`,
      packageName: null,
      language: "typescript",
      chunkKind: "SYMBOL",
      startLine: 1,
      endLine: 10,
      content: `export function fn${i.toString()}() { return ${i.toString()}; }`,
      contentHash: `hash-${i.toString()}`,
      symbols: [`fn${i.toString()}`],
      imports: [],
      tokenCount: 12,
      embeddingModel: "test-model",
      embedding: makeEmbedding(i),
    }),
  );
  const affected = await upsertChunks(chunks);
  expect(affected).toBe(CHUNK_COUNT);
}, 240_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("vector search query plan at scale — 50,000 CodeChunk rows (plan.md §41.3)", () => {
  it("uses an Index Scan on the HNSW index, never a Seq Scan on CodeChunk", async () => {
    const literal = `[${queryEmbedding.join(",")}]`;

    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL hnsw.ef_search = 120`;
      return tx.$queryRaw<ExplainRow[]>`
        EXPLAIN (ANALYZE, FORMAT JSON)
        SELECT "id", "embedding" <=> ${literal}::halfvec(1024) AS "distance"
        FROM "CodeChunk"
        WHERE "repositoryId" = ${repositoryId} AND "embedding" IS NOT NULL
        ORDER BY "embedding" <=> ${literal}::halfvec(1024)
        LIMIT 40
      `;
    });

    const plan = rows[0]!["QUERY PLAN"][0]!.Plan;
    printPlan("vector search (repositoryId-filtered, top-40)", plan);

    const nodes = flattenPlan(plan);
    const seqScans = nodes.filter(
      (n) =>
        n["Node Type"] === "Seq Scan" && n["Relation Name"] === "CodeChunk",
    );
    expect(seqScans).toEqual([]);

    const indexScans = nodes.filter(
      (n) =>
        (n["Node Type"] === "Index Scan" ||
          n["Node Type"] === "Bitmap Index Scan" ||
          n["Node Type"] === "Index Only Scan") &&
        (n["Relation Name"] === "CodeChunk" ||
          n["Index Name"] === "CodeChunk_embedding_hnsw_idx"),
    );
    expect(indexScans.length).toBeGreaterThan(0);
    expect(
      indexScans.some(
        (n) => n["Index Name"] === "CodeChunk_embedding_hnsw_idx",
      ),
    ).toBe(true);
  });

  it("the real search() function returns real results, ordered by descending vectorScore at this scale", async () => {
    const results = await search({
      repositoryId,
      queryEmbedding,
      limit: 40,
    });
    expect(results).toHaveLength(40);
    // HNSW is an *approximate* nearest-neighbor index — it does not guarantee exact
    // pairwise ordering, only that it finds results close to the true top-K. This 50,000-
    // row fixture's smoothly-varying sine-generated embeddings produce a long plateau of
    // near-duplicate vectors near the top of the ranking (unlike real, diverse text
    // embeddings), which makes a strict pairwise `>=` too strict here — it can fail on a
    // difference at the 7th decimal place between two candidates that are, for all
    // practical purposes, tied. The exact, strict ordering assertion already lives in
    // vector-store.test.ts against small, deliberately well-separated vectors; this
    // scale test only needs to confirm the ordering is *approximately* right.
    const APPROXIMATION_TOLERANCE = 1e-4;
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i - 1]!.vectorScore).toBeGreaterThanOrEqual(
        results[i]!.vectorScore - APPROXIMATION_TOLERANCE,
      );
    }
    expect(results.every((r) => r.filePath.startsWith("src/pkg-"))).toBe(true);
  });
});
