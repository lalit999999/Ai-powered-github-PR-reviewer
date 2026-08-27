import { prisma } from "@repo/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildKnowledgeGraph } from "../../src/indexing/graph/graph-builder.js";
import { getFilesImportingFile, getInboundCallers } from "../../src/indexing/graph/graph-queries.repository.js";
import { findRepositoryFilesByCommit } from "../../src/indexing/persistence/repository-file.repository.js";
import { resetDatabase } from "./db-helpers.js";
import { GRAPH_REPO_COMMIT_SHA, GRAPH_REPO_FIXTURE_ROOT, indexGraphRepoFixture } from "./graph-repo-fixture-helpers.js";

/**
 * Prompt 5, sub-task 5.1: structural facts about `tests/fixtures/graph-repo/`, verified by
 * hand-reading the fixture source (see that directory's own `MANIFEST.md`) and cross-checked
 * against the real pipeline's output. Every number here is a real run's output, not a
 * range guess — a future edit to the fixture that changes these numbers should fail this
 * test, which is the point: it is the tripwire that keeps `MANIFEST.md`'s claims honest.
 */

beforeEach(resetDatabase);
afterAll(async () => {
  await prisma.$disconnect();
});

describe("graph-repo fixture — structural facts (phase-04 §14)", () => {
  it("produces the expected file, symbol, and edge counts", async () => {
    const { graph } = await indexGraphRepoFixture();

    // 48 RepositoryFile rows total: 37 real TS/TSX source files parsed OK, 1 deliberately
    // malformed (FAILED), and 10 manifest/markdown files (package.json × 5, tsconfig.json
    // × 5 counted together below, pnpm-workspace.yaml, MANIFEST.md) that are never
    // eligible for parsing at all (NOT_PARSED).
    expect(graph.filesParsedOk).toBe(37);
    expect(graph.parseFailureCount).toBe(1);
    expect(graph.filesNotParsed).toBe(10);
    expect(graph.symbolsCreated).toBe(51);
    expect(graph.edgesCreated).toBe(143);
    expect(graph.unresolvedImportRatio).toBe(0);
  });

  it("marks the deliberately malformed file FAILED without failing the run", async () => {
    const { repository, graph } = await indexGraphRepoFixture();
    expect(graph.parseFailureCount).toBe(1);

    const file = await prisma.repositoryFile.findFirstOrThrow({
      where: { repositoryId: repository.id, path: "src/broken/unparseable.ts" },
      select: { parseState: true, indexState: true, symbolCount: true },
    });
    expect(file.parseState).toBe("FAILED");
    // §4/§15: the file stays text-indexed even though its own parse failed.
    expect(file.indexState).toBe("INDEXED");
    expect(file.symbolCount).toBe(0);
  });

  it("tags every workspace package's files with the declared packageName, and top-level files with the root package's name", async () => {
    const { repository, repoContext } = await indexGraphRepoFixture();

    expect([...repoContext.workspaceRoots].sort()).toEqual(["apps/web", "packages/core", "packages/utils"]);

    const byPath = async (path: string) =>
      prisma.repositoryFile.findFirstOrThrow({ where: { repositoryId: repository.id, path }, select: { packageName: true, isTest: true } });

    await expect(byPath("packages/core/src/auth/login.ts")).resolves.toMatchObject({ packageName: "@fixture/core" });
    await expect(byPath("packages/utils/src/hash.ts")).resolves.toMatchObject({ packageName: "@fixture/utils" });
    await expect(byPath("apps/web/src/main.ts")).resolves.toMatchObject({ packageName: "@fixture/web" });
    // A file with no closer ancestor package.json than the repo root still resolves to
    // *that* manifest's declared name — not null. `getPackageNameForFile`'s
    // nearest-ancestor lookup has no concept of "outside every workspace"; it only knows
    // "no package.json above this file at all", which does not happen here.
    await expect(byPath("src/api/handler.ts")).resolves.toMatchObject({ packageName: "graph-repo-fixture" });
  });

  it("produces TESTS edges from both a path-convention and a framework-import test file to the non-test files they import", async () => {
    const { repository } = await indexGraphRepoFixture();

    const testEdges = await prisma.codeDependency.findMany({
      where: { repositoryId: repository.id, kind: "TESTS" },
      select: { fromFileId: true, toFileId: true },
    });
    const files = await prisma.repositoryFile.findMany({ where: { repositoryId: repository.id }, select: { id: true, path: true, isTest: true } });
    const pathOf = new Map(files.map((f) => [f.id, f.path]));

    const pairs = testEdges.map((e) => ({ from: pathOf.get(e.fromFileId ?? ""), to: pathOf.get(e.toFileId ?? "") })).sort((a, b) => (a.from ?? "").localeCompare(b.from ?? ""));

    expect(pairs).toEqual([
      { from: "apps/web/tests/user-card.test.tsx", to: "apps/web/src/components/user-card.tsx" },
      { from: "src/checks/verify-utils.ts", to: "packages/utils/src/string-utils.ts" },
    ]);

    const pathConventionFile = files.find((f) => f.path === "apps/web/tests/user-card.test.tsx")!;
    const frameworkImportFile = files.find((f) => f.path === "src/checks/verify-utils.ts")!;
    expect(pathConventionFile.isTest).toBe(true);
    expect(frameworkImportFile.isTest).toBe(true);
  });

  it("links the barrel file through to the implementation it re-exports (getFilesImportingFile, depth 2)", async () => {
    const { repository } = await indexGraphRepoFixture();

    const loginFile = await prisma.repositoryFile.findFirstOrThrow({
      where: { repositoryId: repository.id, path: "packages/core/src/auth/login.ts" },
      select: { id: true },
    });

    const importers = await getFilesImportingFile(repository.id, loginFile.id, 2);
    const files = await prisma.repositoryFile.findMany({ where: { repositoryId: repository.id }, select: { id: true, path: true } });
    const pathOf = new Map(files.map((f) => [f.id, f.path]));

    const byPath = new Map(importers.map((r) => [pathOf.get(r.fileId), r.depth]));
    // The barrel itself, one hop away (its `export * from "./auth/login"` folds into
    // an IMPORTS edge — see graph-repo/packages/core/src/index.ts's own comment).
    expect(byPath.get("packages/core/src/index.ts")).toBe(1);
    // apps/web/src/main.ts imports the bare "@fixture/core" specifier, which resolves to
    // the barrel — two hops from login.ts.
    expect(byPath.get("apps/web/src/main.ts")).toBe(2);
    expect(importers).toHaveLength(2);
  });

  describe("findInboundCallers — exact, hand-verified caller sets", () => {
    it("capitalize (packages/utils/src/string-utils.ts) — called cross-package from two files", async () => {
      const { repository } = await indexGraphRepoFixture();
      const symbol = await prisma.codeSymbol.findFirstOrThrow({
        where: { repositoryId: repository.id, name: "capitalize" },
        select: { id: true },
      });

      const callers = await getInboundCallers(repository.id, [symbol.id]);
      const set = callers.map((c) => `${c.filePath}::${c.symbolName}`).sort();

      expect(set).toEqual(["packages/core/src/http/handler.ts::handler", "packages/utils/src/registry.ts::index"].sort());
    });

    it("handler (packages/core/src/http/handler.ts) — one clean named-import caller, one ambiguous ", async () => {
      const { repository } = await indexGraphRepoFixture();
      const file = await prisma.repositoryFile.findFirstOrThrow({
        where: { repositoryId: repository.id, path: "packages/core/src/http/handler.ts" },
        select: { id: true },
      });
      const symbol = await prisma.codeSymbol.findFirstOrThrow({
        where: { repositoryId: repository.id, fileId: file.id, name: "handler" },
        select: { id: true },
      });

      const callers = await getInboundCallers(repository.id, [symbol.id]);
      const set = callers.map((c) => `${c.filePath}::${c.symbolName}`).sort();

      expect(set).toEqual(["packages/core/src/http/router.ts::route", "packages/core/src/jobs/dispatch.ts::dispatch"].sort());
    });

    it("touch (packages/core/src/models/base-entity.ts) — one caller, three levels down the class hierarchy", async () => {
      const { repository } = await indexGraphRepoFixture();
      const symbol = await prisma.codeSymbol.findFirstOrThrow({
        where: { repositoryId: repository.id, name: "touch" },
        select: { id: true },
      });

      const callers = await getInboundCallers(repository.id, [symbol.id]);

      expect(callers).toHaveLength(1);
      expect(callers[0]).toMatchObject({ symbolName: "bump", filePath: "packages/core/src/models/entity.ts" });
    });
  });

  it("the N>3 ambiguity case (render, called from src/api/handler.ts) produces no edge", async () => {
    const { repository } = await indexGraphRepoFixture();

    const callerFile = await prisma.repositoryFile.findFirstOrThrow({
      where: { repositoryId: repository.id, path: "src/api/handler.ts" },
      select: { id: true },
    });
    const callerSymbol = await prisma.codeSymbol.findFirstOrThrow({
      where: { repositoryId: repository.id, fileId: callerFile.id, name: "handle" },
      select: { id: true },
    });

    const renderSymbols = await prisma.codeSymbol.findMany({
      where: { repositoryId: repository.id, name: "render" },
      select: { id: true },
    });
    expect(renderSymbols).toHaveLength(4);

    const edges = await prisma.codeDependency.findMany({
      where: { repositoryId: repository.id, kind: "CALLS", fromSymbolId: callerSymbol.id },
    });
    expect(edges).toHaveLength(0);
  });

  it("re-running graph resolution on the same repository and commit produces no duplicate edges (phase-04 §15)", async () => {
    const { repository, repoContext, graph } = await indexGraphRepoFixture();

    // A second pass over the identical (repositoryId, commitSha) — graph-builder.ts's
    // own full-replace design (delete every existing edge/symbol row for this
    // repositoryId, then insert fresh ones) is what this asserts actually holds, not
    // just what its header comment claims.
    const persistedFiles = await findRepositoryFilesByCommit(repository.id, GRAPH_REPO_COMMIT_SHA);
    const second = await buildKnowledgeGraph({
      rootDir: GRAPH_REPO_FIXTURE_ROOT,
      files: persistedFiles,
      repoContext,
      repositoryId: repository.id,
      commitSha: GRAPH_REPO_COMMIT_SHA,
      attempt: 0,
    });

    expect(second.symbolsCreated).toBe(graph.symbolsCreated);
    expect(second.edgesCreated).toBe(graph.edgesCreated);

    const totalEdges = await prisma.codeDependency.count({ where: { repositoryId: repository.id } });
    const totalSymbols = await prisma.codeSymbol.count({ where: { repositoryId: repository.id } });
    // Not double — the second pass replaced the first pass's rows, it did not add to them.
    expect(totalEdges).toBe(graph.edgesCreated);
    expect(totalSymbols).toBe(graph.symbolsCreated);
  });
});
