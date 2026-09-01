import { randomUUID } from "node:crypto";
import { hybridSearch, prisma, upsertChunks } from "@repo/db";
import type { ChunkUpsertInput } from "@repo/db";
import { EMBEDDING_DIMENSIONS } from "@repo/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDatabase } from "./db-helpers.js";
import { seedRepository } from "./repository-helpers.js";

/**
 * Phase 05 prompt 2, sub-task 2.5: `plan.md` §41.3's framing, applied to the full
 * `hybridSearch` CTE query — proves the vector CTE uses the HNSW index and the lexical
 * CTE uses the GIN index on `CodeChunk.tsv`, at a scale where the planner has a real
 * choice (see `vector-search-query-plans.test.ts`'s own header comment for the measured
 * crossover: a single-repository table needs tens of thousands of rows, not "a few
 * thousand," before Postgres prefers either specialized index over a plain scan+sort).
 * Seeds its own 50,000 rows rather than sharing sub-task 2.3's fixture, so this file
 * stays independently runnable and sub-task 2.3's own commit is untouched.
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

function makeEmbedding(seed: number): number[] {
  return Array.from(
    { length: EMBEDDING_DIMENSIONS },
    (_, i) => Math.sin(seed * 0.017 + i) * 0.1,
  );
}

let repositoryId: string;
const queryEmbedding = makeEmbedding(0);
/** A function name unique to exactly one seeded chunk — a highly selective full-text
 * predicate, the shape that most favors the GIN index over a seq scan. */
const TARGET_SYMBOL_NAME = "veryDistinctiveTargetSymbolName12345";

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

  const chunks: ChunkUpsertInput[] = Array.from(
    { length: CHUNK_COUNT },
    (_, i) => ({
      id: randomUUID(),
      repositoryId,
      fileId: file.id,
      symbolId: null,
      commitSha: "sha1",
      filePath: `src/pkg-${(i % 20).toString()}/file-${i.toString()}.ts`,
      packageName: null,
      language: "typescript",
      chunkKind: "SYMBOL",
      startLine: 1,
      endLine: 10,
      content:
        i === CHUNK_COUNT - 1
          ? `export function ${TARGET_SYMBOL_NAME}() { return 1; }`
          : `export function fn${i.toString()}() { return ${i.toString()}; }`,
      contentHash: `hash-${i.toString()}`,
      symbols: [
        i === CHUNK_COUNT - 1 ? TARGET_SYMBOL_NAME : `fn${i.toString()}`,
      ],
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

describe("hybridSearch query plan at scale — 50,000 CodeChunk rows (plan.md §41.3)", () => {
  it("uses the HNSW index in the vector CTE and the GIN index in the lexical CTE", async () => {
    const literal = `[${queryEmbedding.join(",")}]`;

    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL hnsw.ef_search = 120`;
      return tx.$queryRaw<ExplainRow[]>`
        EXPLAIN (ANALYZE, FORMAT JSON)
        WITH vector_candidates AS (
          SELECT c.id, c."embedding" <=> ${literal}::halfvec(1024) AS distance, NULL::real AS "tsRank"
          FROM "CodeChunk" c
          WHERE c."repositoryId" = ${repositoryId} AND c."embedding" IS NOT NULL
          ORDER BY c."embedding" <=> ${literal}::halfvec(1024)
          LIMIT 40
        ),
        lexical_candidates AS (
          SELECT c.id, NULL::double precision AS distance,
                 ts_rank(c."tsv", websearch_to_tsquery('english', ${TARGET_SYMBOL_NAME})) AS "tsRank"
          FROM "CodeChunk" c
          WHERE c."repositoryId" = ${repositoryId}
            AND c."tsv" @@ websearch_to_tsquery('english', ${TARGET_SYMBOL_NAME})
          ORDER BY ts_rank(c."tsv", websearch_to_tsquery('english', ${TARGET_SYMBOL_NAME})) DESC
          LIMIT 20
        ),
        candidates AS (
          SELECT COALESCE(v.id, l.id) AS id, v.distance, l."tsRank"
          FROM vector_candidates v
          FULL OUTER JOIN lexical_candidates l ON v.id = l.id
        )
        SELECT c.id, c."filePath", cand.distance, cand."tsRank"
        FROM candidates cand
        JOIN "CodeChunk" c ON c.id = cand.id
      `;
    });

    const plan = rows[0]!["QUERY PLAN"][0]!.Plan;
    printPlan("hybridSearch CTE (vector + lexical)", plan);

    const nodes = flattenPlan(plan);
    const seqScans = nodes.filter(
      (n) =>
        n["Node Type"] === "Seq Scan" && n["Relation Name"] === "CodeChunk",
    );
    expect(seqScans).toEqual([]);

    const usesHnsw = nodes.some(
      (n) => n["Index Name"] === "CodeChunk_embedding_hnsw_idx",
    );
    expect(usesHnsw).toBe(true);

    const usesGin = nodes.some(
      (n) =>
        n["Node Type"] === "Bitmap Index Scan" &&
        n["Index Name"] === "CodeChunk_tsv_gin_idx",
    );
    expect(usesGin).toBe(true);
  });

  it("the real hybridSearch() function surfaces the lexically-unique target into the unioned candidate set at this scale", async () => {
    // There are at most 41 total candidates for this query (40 from the vector CTE's
    // own LIMIT, plus the 1 lexical-only match) — limit 41 returns all of them
    // regardless of rank, which is the right assertion here: with lexicalScore weighted
    // at only 0.15 against vectorScore's 0.45, a lexical-only match (vectorScore 0)
    // legitimately does not out-rank 40 genuinely close vector matches for a small
    // limit. This asserts the union/dedup SQL is correct — that the target reaches the
    // candidate set at all — not that it wins the ranking, which is the formula working
    // as designed, not a bug.
    const results = await hybridSearch({
      repositoryId,
      queryEmbedding,
      queryText: TARGET_SYMBOL_NAME,
      limit: 41,
    });
    expect(results.some((r) => r.content.includes(TARGET_SYMBOL_NAME))).toBe(
      true,
    );
  });
});
