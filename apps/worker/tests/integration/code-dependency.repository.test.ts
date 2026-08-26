import { randomUUID } from "node:crypto";
import { prisma } from "@repo/db";
import type { DependencyKind } from "@repo/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  countInboundEdgesByFile,
  deleteCodeDependenciesByRepository,
  insertCodeDependencies,
  type CodeDependencyInsertInput,
} from "../../src/indexing/persistence/code-dependency.repository.js";
import { resetDatabase } from "./db-helpers.js";
import { seedRepository } from "./repository-helpers.js";

/**
 * Sub-task 4.2's own Definition of Done: every `DependencyKind` value round-trips, the
 * same edge set inserted twice produces no duplicates (spec §15's acceptance criterion,
 * tested directly at the persistence layer), and tenant isolation holds. Matches
 * code-symbol.repository.test.ts's own convention: `*.repository.ts` files are exercised
 * for real only via Testcontainers integration tests.
 */

beforeEach(resetDatabase);
afterAll(async () => {
  await prisma.$disconnect();
});

async function seedRepositoryFile(repositoryId: string, path: string): Promise<string> {
  const file = await prisma.repositoryFile.create({
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
  return file.id;
}

async function seedCodeSymbol(repositoryId: string, fileId: string, name: string): Promise<string> {
  const symbol = await prisma.codeSymbol.create({
    data: { repositoryId, fileId, name, kind: "FUNCTION", startLine: 1, endLine: 2, commitSha: "sha1" },
  });
  return symbol.id;
}

function makeEdge(
  overrides: Partial<CodeDependencyInsertInput> & Pick<CodeDependencyInsertInput, "repositoryId" | "kind">,
): CodeDependencyInsertInput {
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

const ALL_KINDS: DependencyKind[] = ["IMPORTS", "EXPORTS", "CONTAINS", "CALLS", "EXTENDS", "IMPLEMENTS", "REFERENCES", "TESTS"];

describe("insertCodeDependencies", () => {
  it("bulk inserts across all eight DependencyKind values", async () => {
    const repo = await seedRepository();
    const fileA = await seedRepositoryFile(repo.id, "src/a.ts");
    const fileB = await seedRepositoryFile(repo.id, "src/b.ts");
    const symA = await seedCodeSymbol(repo.id, fileA, "a");
    const symB = await seedCodeSymbol(repo.id, fileB, "b");

    const edges = ALL_KINDS.map((kind) =>
      makeEdge({
        repositoryId: repo.id,
        kind,
        fromFileId: fileA,
        toFileId: fileB,
        fromSymbolId: symA,
        toSymbolId: symB,
      }),
    );

    const counts = await insertCodeDependencies(edges);

    const total = await prisma.codeDependency.count({ where: { repositoryId: repo.id } });
    expect(total).toBe(ALL_KINDS.length);
    for (const kind of ALL_KINDS) {
      expect(counts[kind]?.RESOLVED).toBe(1);
    }
  });

  it("inserting the same edge set twice produces no duplicates (spec §15)", async () => {
    const repo = await seedRepository();
    const fileA = await seedRepositoryFile(repo.id, "src/a.ts");
    const fileB = await seedRepositoryFile(repo.id, "src/b.ts");

    const edge = makeEdge({ repositoryId: repo.id, kind: "IMPORTS", fromFileId: fileA, toFileId: fileB });

    await insertCodeDependencies([edge]);
    // A distinct id, but identical identity columns (repositoryId, kind, from/to) — the
    // exact shape ON CONFLICT ON CONSTRAINT "CodeDependency_edge_identity_key" exists to
    // catch, since a real full-replace run always deletes before re-inserting and this
    // conflict should never legitimately fire.
    const duplicate = { ...edge, id: randomUUID() };
    const counts = await insertCodeDependencies([duplicate]);

    expect(await prisma.codeDependency.count({ where: { repositoryId: repo.id } })).toBe(1);
    // The conflict-skipped row is correctly excluded from the returned insert count.
    expect(counts.IMPORTS?.RESOLVED).toBe(0);
  });

  it("two file-level edges with identical kind/endpoints and both symbol columns NULL still collide (NULLS NOT DISTINCT)", async () => {
    const repo = await seedRepository();
    const fileA = await seedRepositoryFile(repo.id, "src/a.ts");
    const fileB = await seedRepositoryFile(repo.id, "src/b.ts");

    const edge = makeEdge({ repositoryId: repo.id, kind: "IMPORTS", fromFileId: fileA, toFileId: fileB });
    await insertCodeDependencies([edge]);
    await insertCodeDependencies([{ ...edge, id: randomUUID() }]);

    expect(await prisma.codeDependency.count({ where: { repositoryId: repo.id } })).toBe(1);
  });
});

describe("deleteCodeDependenciesByRepository — tenant isolation", () => {
  it("removes only the target repository's rows; a second repository's edges survive", async () => {
    const repoA = await seedRepository();
    const repoB = await seedRepository();
    const fileA1 = await seedRepositoryFile(repoA.id, "src/a1.ts");
    const fileA2 = await seedRepositoryFile(repoA.id, "src/a2.ts");
    const fileB1 = await seedRepositoryFile(repoB.id, "src/b1.ts");
    const fileB2 = await seedRepositoryFile(repoB.id, "src/b2.ts");

    await insertCodeDependencies([makeEdge({ repositoryId: repoA.id, kind: "IMPORTS", fromFileId: fileA1, toFileId: fileA2 })]);
    await insertCodeDependencies([makeEdge({ repositoryId: repoB.id, kind: "IMPORTS", fromFileId: fileB1, toFileId: fileB2 })]);

    const removed = await deleteCodeDependenciesByRepository(repoA.id);
    expect(removed).toBe(1);

    expect(await prisma.codeDependency.count({ where: { repositoryId: repoA.id } })).toBe(0);
    expect(await prisma.codeDependency.count({ where: { repositoryId: repoB.id } })).toBe(1);
  });
});

describe("countInboundEdgesByFile", () => {
  it("counts both direct file-level edges and edges to symbols the file contains, scoped to one repository", async () => {
    const repo = await seedRepository();
    const other = await seedRepository();
    const util = await seedRepositoryFile(repo.id, "src/util.ts");
    const caller1 = await seedRepositoryFile(repo.id, "src/caller1.ts");
    const caller2 = await seedRepositoryFile(repo.id, "src/caller2.ts");
    const leaf = await seedRepositoryFile(repo.id, "src/leaf.ts");
    const utilFn = await seedCodeSymbol(repo.id, util, "utilFn");
    const otherFile = await seedRepositoryFile(other.id, "src/other.ts");

    await insertCodeDependencies([
      // Direct file-level edge into `util`.
      makeEdge({ repositoryId: repo.id, kind: "IMPORTS", fromFileId: caller1, toFileId: util }),
      // Two symbol-level edges into utilFn (owned by `util`).
      makeEdge({ repositoryId: repo.id, kind: "CALLS", fromFileId: caller1, toSymbolId: utilFn }),
      makeEdge({ repositoryId: repo.id, kind: "CALLS", fromFileId: caller2, toSymbolId: utilFn }),
      // Noise in a different repository — must not leak into repo's counts.
      makeEdge({ repositoryId: other.id, kind: "IMPORTS", fromFileId: otherFile, toFileId: otherFile }),
    ]);

    const counts = await countInboundEdgesByFile(repo.id);
    const byFile = new Map(counts.map((c) => [c.fileId, c.inboundEdgeCount]));

    // 1 direct + 2 symbol-level = 3 inbound edges for the shared util module.
    expect(byFile.get(util)).toBe(3);
    // The leaf file has no inbound edges at all — absent from the result entirely.
    expect(byFile.has(leaf)).toBe(false);
    expect(byFile.get(util)).toBeGreaterThan(byFile.get(leaf) ?? 0);
  });
});
