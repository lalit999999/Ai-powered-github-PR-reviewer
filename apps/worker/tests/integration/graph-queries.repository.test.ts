import { randomUUID } from "node:crypto";
import { prisma } from "@repo/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CodeDependencyInsertInput } from "../../src/indexing/persistence/code-dependency.repository.js";
import { insertCodeDependencies } from "../../src/indexing/persistence/code-dependency.repository.js";
import type { CodeSymbolInsertInput } from "../../src/indexing/persistence/code-symbol.repository.js";
import { insertCodeSymbols } from "../../src/indexing/persistence/code-symbol.repository.js";
import { getFilesImportingFile, getInboundCallers, getKnowledgeGraphSummary } from "../../src/indexing/graph/graph-queries.repository.js";
import { resetDatabase } from "./db-helpers.js";
import { seedRepository } from "./repository-helpers.js";

/**
 * Sub-task 4.5's own Definition of Done: all three query families, a cycle-safe
 * recursive CTE (tested against a real circular-import fixture), a cross-repository
 * isolation test (the same adversarial pattern `apps/api/tests/integration/cross-tenant.test.ts`
 * uses), and pasted `EXPLAIN ANALYZE` output for queries 1 and 2 showing index usage.
 */

beforeEach(resetDatabase);
afterAll(async () => {
  await prisma.$disconnect();
});

async function seedFile(repositoryId: string, path: string) {
  return prisma.repositoryFile.create({
    data: {
      repositoryId,
      path,
      commitSha: "sha1",
      language: "typescript",
      contentHash: "hash",
      sizeBytes: 10,
      lineCount: 1,
      classification: "SOURCE",
      indexState: "INDEXED",
    },
  });
}

function makeSymbol(overrides: Partial<CodeSymbolInsertInput> & Pick<CodeSymbolInsertInput, "repositoryId" | "fileId">): CodeSymbolInsertInput {
  return {
    id: randomUUID(),
    name: "fn",
    kind: "FUNCTION",
    startLine: 1,
    endLine: 2,
    isExported: true,
    isDefault: false,
    signature: null,
    docComment: null,
    parentSymbolId: null,
    complexity: 1,
    commitSha: "sha1",
    ...overrides,
  };
}

function makeEdge(overrides: Partial<CodeDependencyInsertInput> & Pick<CodeDependencyInsertInput, "repositoryId" | "kind">): CodeDependencyInsertInput {
  return {
    id: randomUUID(),
    fromFileId: null,
    toFileId: null,
    fromSymbolId: null,
    toSymbolId: null,
    externalPackage: null,
    rawSpecifier: null,
    resolution: "RESOLVED",
    confidence: 1,
    commitSha: "sha1",
    ...overrides,
  };
}

describe("getInboundCallers", () => {
  it("returns callers of a symbol, ordered by confidence DESC, scoped to one repository", async () => {
    const repo = await seedRepository();
    const other = await seedRepository();
    const fileA = await seedFile(repo.id, "src/a.ts");
    const fileB = await seedFile(repo.id, "src/b.ts");
    const target = makeSymbol({ repositoryId: repo.id, fileId: fileB.id, name: "target" });
    const lowConfCaller = makeSymbol({ repositoryId: repo.id, fileId: fileA.id, name: "lowCaller" });
    const highConfCaller = makeSymbol({ repositoryId: repo.id, fileId: fileA.id, name: "highCaller" });
    await insertCodeSymbols([target, lowConfCaller, highConfCaller]);

    // Noise in a different repository, including a symbol id collision risk avoided by
    // randomUUID — proves the repositoryId clause, not just symbolId matching, is real.
    const otherFile = await seedFile(other.id, "src/other.ts");
    const otherTarget = makeSymbol({ repositoryId: other.id, fileId: otherFile.id, name: "target" });
    const otherCaller = makeSymbol({ repositoryId: other.id, fileId: otherFile.id, name: "otherCaller" });
    await insertCodeSymbols([otherTarget, otherCaller]);

    await insertCodeDependencies([
      makeEdge({ repositoryId: repo.id, kind: "CALLS", fromSymbolId: lowConfCaller.id, toSymbolId: target.id, confidence: 0.4 }),
      makeEdge({ repositoryId: repo.id, kind: "CALLS", fromSymbolId: highConfCaller.id, toSymbolId: target.id, confidence: 0.95 }),
      // Not an inbound-caller kind — must be excluded.
      makeEdge({ repositoryId: repo.id, kind: "CONTAINS", fromFileId: fileB.id, toSymbolId: target.id, confidence: 1 }),
      makeEdge({ repositoryId: other.id, kind: "CALLS", fromSymbolId: otherCaller.id, toSymbolId: otherTarget.id, confidence: 1 }),
    ]);

    const result = await getInboundCallers(repo.id, [target.id]);

    expect(result).toHaveLength(2);
    expect(result[0]!.symbolName).toBe("highCaller");
    expect(result[1]!.symbolName).toBe("lowCaller");
    expect(result.every((r) => r.filePath === "src/a.ts")).toBe(true);
  });

  it("cross-tenant isolation: a repositoryId that doesn't own the symbol returns nothing", async () => {
    const repo = await seedRepository();
    const other = await seedRepository();
    const file = await seedFile(repo.id, "src/a.ts");
    const target = makeSymbol({ repositoryId: repo.id, fileId: file.id });
    const caller = makeSymbol({ repositoryId: repo.id, fileId: file.id, name: "caller" });
    await insertCodeSymbols([target, caller]);
    await insertCodeDependencies([makeEdge({ repositoryId: repo.id, kind: "CALLS", fromSymbolId: caller.id, toSymbolId: target.id })]);

    // Querying with the OTHER repository's id, but repo's real symbol id.
    const result = await getInboundCallers(other.id, [target.id]);
    expect(result).toHaveLength(0);
  });

  it("returns an empty array immediately for an empty symbolIds list, without querying", async () => {
    const repo = await seedRepository();
    expect(await getInboundCallers(repo.id, [])).toEqual([]);
  });
});

describe("getFilesImportingFile", () => {
  it("walks a chain to depth 2 with the correct distance", async () => {
    const repo = await seedRepository();
    const a = await seedFile(repo.id, "src/a.ts");
    const b = await seedFile(repo.id, "src/b.ts");
    const c = await seedFile(repo.id, "src/c.ts");
    // a imports b, b imports c — dependents of c: {b: depth1, a: depth2}.
    await insertCodeDependencies([
      makeEdge({ repositoryId: repo.id, kind: "IMPORTS", fromFileId: a.id, toFileId: b.id }),
      makeEdge({ repositoryId: repo.id, kind: "IMPORTS", fromFileId: b.id, toFileId: c.id }),
    ]);

    const result = await getFilesImportingFile(repo.id, c.id);
    const byId = new Map(result.map((r) => [r.fileId, r.depth]));
    expect(byId.get(b.id)).toBe(1);
    expect(byId.get(a.id)).toBe(2);
    expect(byId.has(a.id) && byId.has(b.id)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("is cycle-safe: a circular import pair completes quickly and returns a finite, correct result", async () => {
    const repo = await seedRepository();
    const x = await seedFile(repo.id, "src/x.ts");
    const y = await seedFile(repo.id, "src/y.ts");
    // x imports y, y imports x — a real circular import.
    await insertCodeDependencies([
      makeEdge({ repositoryId: repo.id, kind: "IMPORTS", fromFileId: x.id, toFileId: y.id }),
      makeEdge({ repositoryId: repo.id, kind: "IMPORTS", fromFileId: y.id, toFileId: x.id }),
    ]);

    const start = Date.now();
    const result = await getFilesImportingFile(repo.id, x.id);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(5000); // did not hang
    const byId = new Map(result.map((r) => [r.fileId, r.depth]));
    expect(byId.get(y.id)).toBe(1); // y directly imports x
    expect(byId.get(x.id)).toBe(2); // x imports y, which imports x — depth 2, harmless
    expect(result).toHaveLength(2);
  });

  it("cross-tenant isolation: a different repository's import graph never leaks in", async () => {
    const repo = await seedRepository();
    const other = await seedRepository();
    const target = await seedFile(repo.id, "src/target.ts");
    const otherTarget = await seedFile(other.id, "src/target.ts");
    const otherImporter = await seedFile(other.id, "src/importer.ts");
    await insertCodeDependencies([makeEdge({ repositoryId: other.id, kind: "IMPORTS", fromFileId: otherImporter.id, toFileId: otherTarget.id })]);

    const result = await getFilesImportingFile(repo.id, target.id);
    expect(result).toHaveLength(0);
  });
});

describe("getKnowledgeGraphSummary", () => {
  it("aggregates file/symbol/edge counts, the unresolved-import ratio, and top files by inbound edges", async () => {
    const repo = await seedRepository();
    const util = await seedFile(repo.id, "src/util.ts");
    const leaf = await seedFile(repo.id, "src/leaf.ts");
    const other = await seedFile(repo.id, "src/other.ts");
    await prisma.repositoryFile.update({ where: { id: util.id }, data: { inboundEdgeCount: 10 } });
    await prisma.repositoryFile.update({ where: { id: leaf.id }, data: { inboundEdgeCount: 1 } });

    const sym = makeSymbol({ repositoryId: repo.id, fileId: util.id });
    await insertCodeSymbols([sym]);

    // EXTERNAL/UNRESOLVED edges deliberately come from *different* fromFileIds here.
    // `CodeDependency_edge_identity_key` (hand-written in prompt 1, `UNIQUE NULLS NOT
    // DISTINCT` on repositoryId/kind/fromFileId/toFileId/fromSymbolId/toSymbolId) has no
    // column for externalPackage/rawSpecifier, so two EXTERNAL (or two UNRESOLVED)
    // IMPORTS edges from the *same* file collide on that tuple and one is silently
    // dropped by `ON CONFLICT DO NOTHING` — a real gap flagged in the phase-04 report,
    // out of scope to fix here (schema change from a prior prompt). Using distinct
    // fromFileIds keeps this test exercising the ratio math, not that gap.
    await insertCodeDependencies([
      makeEdge({ repositoryId: repo.id, kind: "IMPORTS", fromFileId: leaf.id, toFileId: util.id, resolution: "RESOLVED" }),
      makeEdge({ repositoryId: repo.id, kind: "IMPORTS", fromFileId: leaf.id, externalPackage: "zod", resolution: "EXTERNAL" }),
      makeEdge({ repositoryId: repo.id, kind: "IMPORTS", fromFileId: other.id, rawSpecifier: "./missing.js", resolution: "UNRESOLVED" }),
    ]);

    const summary = await getKnowledgeGraphSummary(repo.id);

    expect(summary.fileCount).toBe(3);
    expect(summary.symbolCount).toBe(1);
    expect(summary.edgeCount).toBe(3);
    expect(summary.unresolvedImportRatio).toBeCloseTo(1 / 3, 5);
    expect(summary.topFilesByInboundEdges[0]!.path).toBe("src/util.ts");
    expect(summary.topFilesByInboundEdges[0]!.inboundEdgeCount).toBe(10);
  });

  it("cross-tenant isolation: counts never include another repository's rows", async () => {
    const repo = await seedRepository();
    const other = await seedRepository();
    await seedFile(other.id, "src/noise.ts");

    const summary = await getKnowledgeGraphSummary(repo.id);
    expect(summary.fileCount).toBe(0);
  });
});

describe("EXPLAIN ANALYZE — index usage for queries 1 and 2", () => {
  it("prints EXPLAIN ANALYZE for getInboundCallers and getFilesImportingFile against a non-trivial seeded graph", async () => {
    const repo = await seedRepository();
    const files = await Promise.all(Array.from({ length: 20 }, (_, i) => seedFile(repo.id, `src/f${i.toString()}.ts`)));
    const symbols = files.map((f) => makeSymbol({ repositoryId: repo.id, fileId: f.id, name: `sym_${f.id}` }));
    await insertCodeSymbols(symbols);

    const edges: CodeDependencyInsertInput[] = [];
    for (let i = 1; i < symbols.length; i += 1) {
      edges.push(makeEdge({ repositoryId: repo.id, kind: "CALLS", fromSymbolId: symbols[i]!.id, toSymbolId: symbols[0]!.id, confidence: 0.5 }));
    }
    for (let i = 1; i < files.length; i += 1) {
      edges.push(makeEdge({ repositoryId: repo.id, kind: "IMPORTS", fromFileId: files[i]!.id, toFileId: files[0]!.id }));
    }
    await insertCodeDependencies(edges);

    const targetSymbolId = symbols[0]!.id;
    const explain1 = await prisma.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
      `EXPLAIN ANALYZE
       SELECT d.id, d.kind, d."fromSymbolId", d."toSymbolId", d.confidence, s.name, f.path
       FROM "CodeDependency" d
       JOIN "CodeSymbol" s ON s.id = d."fromSymbolId"
       JOIN "RepositoryFile" f ON f.id = s."fileId"
       WHERE d."toSymbolId" = ANY(ARRAY['${targetSymbolId}']::text[])
         AND d.kind::text IN ('CALLS','REFERENCES','EXTENDS','IMPLEMENTS')
         AND d."repositoryId" = '${repo.id}'
       ORDER BY d.confidence DESC
       LIMIT 50;`,
    );
    console.log("\n--- EXPLAIN ANALYZE: getInboundCallers ---\n" + explain1.map((r) => r["QUERY PLAN"]).join("\n"));

    const targetFileId = files[0]!.id;
    const explain2 = await prisma.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
      `EXPLAIN ANALYZE
       WITH RECURSIVE dependents AS (
         SELECT "fromFileId" AS file_id, 1 AS depth
         FROM "CodeDependency"
         WHERE "toFileId" = '${targetFileId}' AND kind = 'IMPORTS' AND "repositoryId" = '${repo.id}'
         UNION
         SELECT d."fromFileId", dep.depth + 1
         FROM "CodeDependency" d
         JOIN dependents dep ON d."toFileId" = dep.file_id
         WHERE d.kind = 'IMPORTS' AND d."repositoryId" = '${repo.id}' AND dep.depth < 2
       )
       SELECT file_id, MIN(depth)::int AS depth FROM dependents GROUP BY file_id;`,
    );
    console.log("\n--- EXPLAIN ANALYZE: getFilesImportingFile ---\n" + explain2.map((r) => r["QUERY PLAN"]).join("\n"));

    expect(explain1.length).toBeGreaterThan(0);
    expect(explain2.length).toBeGreaterThan(0);
  });
});
