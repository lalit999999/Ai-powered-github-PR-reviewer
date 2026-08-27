import { randomUUID } from "node:crypto";
import { prisma } from "@repo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodeDependencyInsertInput } from "../../src/indexing/persistence/code-dependency.repository.js";
import { insertCodeDependencies } from "../../src/indexing/persistence/code-dependency.repository.js";
import type { CodeSymbolInsertInput } from "../../src/indexing/persistence/code-symbol.repository.js";
import { insertCodeSymbols } from "../../src/indexing/persistence/code-symbol.repository.js";
import { getFilesImportingFile, getInboundCallers } from "../../src/indexing/graph/graph-queries.repository.js";
import { resetDatabase } from "./db-helpers.js";
import { seedRepository } from "./repository-helpers.js";

/**
 * Prompt 5, sub-task 5.3(c): `plan.md` §41.3's own framing — "a test that fails if a query
 * plan degrades to a seq scan is worth ten load tests." `graph-queries.repository.test.ts`
 * (Prompt 4) already asserts index usage, but against a handful of rows — small enough
 * that Postgres *correctly* prefers a sequential scan over an index scan on such a tiny
 * table, which would make that assertion pass for the wrong reason at this scale. This
 * file seeds **10,000+ `CodeSymbol` rows and 30,000+ `CodeDependency` rows** — large enough
 * that the planner's own cost model prefers an index — and re-asserts the same property at
 * a size where "no seq scan" is actually meaningful.
 *
 * One repository, seeded once in `beforeAll` (not per-`it`): building this graph is the
 * expensive part of this file, and every `it` below only reads it.
 */

const FILE_COUNT = 500;
const SYMBOLS_PER_FILE = 20; // 500 * 20 = 10,000 CodeSymbol rows
const CALLS_PER_SYMBOL = 3; // ~30,000 CALLS edges
const IMPORT_CHAIN_LENGTH = 400; // a long linear import chain for the depth-2 CTE query

/** p95 budget from `plan.md` §41.1 is 80ms in production; this asserts a single run (not a
 * sampled p95) inside a shared Testcontainers Postgres on a CI-class container, so the
 * bound here is deliberately generous — 500ms, roughly 6x the production p95 — while still
 * being tight enough to catch an actual seq-scan regression, which would be orders of
 * magnitude slower than either number at this row count. */
const QUERY_BUDGET_MS = 500;

interface ExplainRow {
  "QUERY PLAN": [{ Plan: PlanNode; "Execution Time": number }];
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
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

let repositoryId: string;
let hotSymbolId: string; // has CALLS_PER_SYMBOL-independent, deliberately large inbound-caller count
let chainStartFileId: string; // one end of IMPORT_CHAIN_LENGTH's linear import chain

beforeAll(async () => {
  await resetDatabase();
  const repo = await seedRepository();
  repositoryId = repo.id;

  // --- Files ---
  const fileIds: string[] = [];
  const filePathValues = Array.from({ length: FILE_COUNT }, (_, i) => `src/pkg-${(i % 20).toString()}/file-${i.toString()}.ts`);
  for (let i = 0; i < FILE_COUNT; i += 1) {
    const created = await prisma.repositoryFile.create({
      data: {
        repositoryId,
        path: filePathValues[i]!,
        commitSha: "sha1",
        language: "typescript",
        contentHash: `hash-${i.toString()}`,
        sizeBytes: 100,
        lineCount: 10,
        classification: "SOURCE",
        indexState: "INDEXED",
      },
      select: { id: true },
    });
    fileIds.push(created.id);
  }
  chainStartFileId = fileIds[0]!;

  // --- Symbols: SYMBOLS_PER_FILE per file, 10,000 total ---
  const symbolRows: CodeSymbolInsertInput[] = [];
  const symbolIdsByFile: string[][] = [];
  for (let f = 0; f < FILE_COUNT; f += 1) {
    const ids: string[] = [];
    for (let s = 0; s < SYMBOLS_PER_FILE; s += 1) {
      const id = randomUUID();
      ids.push(id);
      symbolRows.push({
        id,
        repositoryId,
        fileId: fileIds[f]!,
        name: `sym_${f.toString()}_${s.toString()}`,
        kind: "FUNCTION",
        startLine: s + 1,
        endLine: s + 2,
        isExported: true,
        isDefault: false,
        signature: null,
        docComment: null,
        parentSymbolId: null,
        complexity: 1,
        commitSha: "sha1",
      });
    }
    symbolIdsByFile.push(ids);
  }
  await insertCodeSymbols(symbolRows);
  expect(symbolRows.length).toBeGreaterThanOrEqual(10_000);

  const allSymbolIds = symbolIdsByFile.flat();
  hotSymbolId = allSymbolIds[Math.floor(allSymbolIds.length / 2)]!;

  // --- CALLS edges: every symbol calls CALLS_PER_SYMBOL others, plus a deliberately hot
  // target with many extra inbound callers (the getInboundCallers query's own subject). ---
  const edgeRows: CodeDependencyInsertInput[] = [];
  function edgeRow(overrides: Partial<CodeDependencyInsertInput> & Pick<CodeDependencyInsertInput, "kind">): CodeDependencyInsertInput {
    return {
      id: randomUUID(),
      repositoryId,
      fromFileId: null,
      toFileId: null,
      fromSymbolId: null,
      toSymbolId: null,
      externalPackage: null,
      rawSpecifier: null,
      resolution: "RESOLVED",
      confidence: 0.9,
      commitSha: "sha1",
      ...overrides,
    };
  }

  for (let i = 0; i < allSymbolIds.length; i += 1) {
    for (let c = 0; c < CALLS_PER_SYMBOL; c += 1) {
      const targetIdx = (i + c + 1) % allSymbolIds.length;
      edgeRows.push(edgeRow({ kind: "CALLS", fromSymbolId: allSymbolIds[i]!, toSymbolId: allSymbolIds[targetIdx]!, confidence: 0.7 }));
    }
  }
  // 50 extra, distinct callers of hotSymbolId so getInboundCallers has real fan-in to sort.
  for (let i = 0; i < 50; i += 1) {
    edgeRows.push(edgeRow({ kind: "CALLS", fromSymbolId: allSymbolIds[i]!, toSymbolId: hotSymbolId, confidence: 0.5 + i / 100 }));
  }

  // --- IMPORTS edges: a long linear chain (fileIds[0] <- fileIds[1] <- ... ) for the
  // depth-2 recursive CTE query, plus scattered noise imports for volume. ---
  for (let i = 1; i < IMPORT_CHAIN_LENGTH; i += 1) {
    edgeRows.push(edgeRow({ kind: "IMPORTS", fromFileId: fileIds[i]!, toFileId: fileIds[i - 1]!, resolution: "RESOLVED" }));
  }
  for (let i = 0; i < FILE_COUNT; i += 1) {
    const target = fileIds[(i * 37 + 11) % FILE_COUNT]!;
    if (target === fileIds[i]) continue;
    edgeRows.push(edgeRow({ kind: "IMPORTS", fromFileId: fileIds[i]!, toFileId: target, resolution: "RESOLVED" }));
  }

  await insertCodeDependencies(edgeRows);
  expect(edgeRows.length).toBeGreaterThanOrEqual(30_000);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("graph query plans at scale — 10,000+ symbols, 30,000+ edges (plan.md §41.3)", () => {
  it("getInboundCallers uses an Index/Bitmap Index Scan on CodeDependency and CodeSymbol, never a Seq Scan", async () => {
    const rows = await prisma.$queryRaw<ExplainRow[]>`
      EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT
        d.id AS "dependencyId", d.kind AS "kind", d."fromSymbolId" AS "fromSymbolId",
        d."toSymbolId" AS "toSymbolId", d.confidence AS "confidence", s.name AS "symbolName", f.path AS "filePath"
      FROM "CodeDependency" d
      JOIN "CodeSymbol" s ON s.id = d."fromSymbolId"
      JOIN "RepositoryFile" f ON f.id = s."fileId"
      WHERE d."toSymbolId" = ANY(${[hotSymbolId]})
        AND d.kind::text IN ('CALLS','REFERENCES','EXTENDS','IMPLEMENTS')
        AND d."repositoryId" = ${repositoryId}
      ORDER BY d.confidence DESC
      LIMIT 50
    `;
    const plan = rows[0]!["QUERY PLAN"][0]!.Plan;
    printPlan("getInboundCallers", plan);

    const nodes = flattenPlan(plan);
    const seqScans = nodes.filter((n) => n["Node Type"] === "Seq Scan" && (n["Relation Name"] === "CodeDependency" || n["Relation Name"] === "CodeSymbol"));
    expect(seqScans).toEqual([]);
    const indexNodes = nodes.filter((n) => n["Node Type"] === "Index Scan" || n["Node Type"] === "Bitmap Index Scan" || n["Node Type"] === "Index Only Scan");
    expect(indexNodes.length).toBeGreaterThan(0);

    // Real caller data, not an empty result the planner trivially fast-pathed.
    const real = await getInboundCallers(repositoryId, [hotSymbolId], 50);
    expect(real.length).toBeGreaterThanOrEqual(50);
  });

  it("getFilesImportingFile (depth-2 recursive CTE) uses an Index/Bitmap Index Scan, never a Seq Scan, and completes within budget", async () => {
    const rows = await prisma.$queryRaw<ExplainRow[]>`
      EXPLAIN (ANALYZE, FORMAT JSON)
      WITH RECURSIVE dependents AS (
        SELECT "fromFileId" AS file_id, 1 AS depth
        FROM "CodeDependency"
        WHERE "toFileId" = ${chainStartFileId} AND kind = 'IMPORTS' AND "repositoryId" = ${repositoryId}
        UNION
        SELECT d."fromFileId", dep.depth + 1
        FROM "CodeDependency" d
        JOIN dependents dep ON d."toFileId" = dep.file_id
        WHERE d.kind = 'IMPORTS' AND d."repositoryId" = ${repositoryId} AND dep.depth < 2
      )
      SELECT file_id AS "fileId", MIN(depth)::int AS "depth" FROM dependents GROUP BY file_id
    `;
    const plan = rows[0]!["QUERY PLAN"][0]!.Plan;
    printPlan("getFilesImportingFile", plan);

    const nodes = flattenPlan(plan);
    const seqScans = nodes.filter((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "CodeDependency");
    expect(seqScans).toEqual([]);
    const indexNodes = nodes.filter((n) => n["Node Type"] === "Index Scan" || n["Node Type"] === "Bitmap Index Scan" || n["Node Type"] === "Index Only Scan");
    expect(indexNodes.length).toBeGreaterThan(0);

    const executionTimeMs = rows[0]!["QUERY PLAN"][0]!["Execution Time"];
    console.log(`getFilesImportingFile execution time: ${executionTimeMs.toFixed(2)}ms (budget ${QUERY_BUDGET_MS.toString()}ms)`);
    expect(executionTimeMs).toBeLessThan(QUERY_BUDGET_MS);

    // The real query call, proving depth actually reaches 2 on this seeded chain.
    const real = await getFilesImportingFile(repositoryId, chainStartFileId, 2);
    expect(real.some((r) => r.depth === 2)).toBe(true);
  });
});
