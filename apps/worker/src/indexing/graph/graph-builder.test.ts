import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeDependencyInsertInput } from "../persistence/code-dependency.repository.js";
import type { CodeSymbolInsertInput } from "../persistence/code-symbol.repository.js";
import { buildRepoContext } from "./repo-context.js";

/**
 * Sub-task 4.3's own Definition of Done: both passes implemented, full-replace ordering
 * (edges deleted before symbols), attempt-aware batching, and "a single malformed file
 * cannot fail the run" — tested against **real** source snippets parsed by the real
 * tree-sitter pipeline (matching this codebase's own established convention — see
 * walk-tree.test.ts / archive-extractor.test.ts — of exercising real behavior over a real
 * temp directory rather than mocking the parser). Only the persistence layer
 * (`*.repository.ts`, which requires a live Postgres) is mocked, matching
 * indexer.service.test.ts's own documented convention.
 */

const callOrder: string[] = [];

const insertCodeSymbols = vi.fn(async (_rows: CodeSymbolInsertInput[]) => {
  callOrder.push("insertCodeSymbols");
});
const deleteCodeSymbolsByRepository = vi.fn(async (_repositoryId: string) => {
  callOrder.push("deleteCodeSymbolsByRepository");
  return 0;
});
vi.mock("../persistence/code-symbol.repository.js", () => ({
  insertCodeSymbols: (rows: CodeSymbolInsertInput[]) => insertCodeSymbols(rows),
  deleteCodeSymbolsByRepository: (repositoryId: string) => deleteCodeSymbolsByRepository(repositoryId),
}));

const insertedEdges: CodeDependencyInsertInput[] = [];
const insertCodeDependencies = vi.fn(async (rows: CodeDependencyInsertInput[]) => {
  callOrder.push("insertCodeDependencies");
  insertedEdges.push(...rows);
  const counts: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    counts[row.kind] ??= {};
    counts[row.kind]![row.resolution] = (counts[row.kind]![row.resolution] ?? 0) + 1;
  }
  return counts;
});
const deleteCodeDependenciesByRepository = vi.fn(async (_repositoryId: string) => {
  callOrder.push("deleteCodeDependenciesByRepository");
  return 0;
});
vi.mock("../persistence/code-dependency.repository.js", () => ({
  insertCodeDependencies: (rows: CodeDependencyInsertInput[]) => insertCodeDependencies(rows),
  deleteCodeDependenciesByRepository: (repositoryId: string) => deleteCodeDependenciesByRepository(repositoryId),
}));

const { buildKnowledgeGraph, batchSizeForAttempt } = await import("./graph-builder.js");

function noopLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const tempRoots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  callOrder.length = 0;
  insertedEdges.length = 0;
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "graph-builder-test-"));
  tempRoots.push(dir);
  return dir;
}

async function writeFile(rootDir: string, relativePath: string, content: string): Promise<void> {
  const full = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}

interface FixtureFile {
  path: string;
  content: string;
  isTest?: boolean;
}

/** Builds a real RepoContext (via prompt 3's own `buildRepoContext`) against a real temp
 * directory, and a `GraphBuilderFileInput[]` matching every fixture file — INDEXED, the
 * shape `walkTree`'s own output takes. */
async function setupFixture(files: FixtureFile[]) {
  const rootDir = await makeTempRoot();
  for (const f of files) await writeFile(rootDir, f.path, f.content);

  const repoContext = await buildRepoContext(
    rootDir,
    files.map((f) => f.path),
  );

  const graphFiles = files.map((f, i) => ({ id: `file-${i.toString()}`, path: f.path, indexState: "INDEXED" as const, isTest: f.isTest ?? false }));

  return { rootDir, repoContext, graphFiles };
}

const BASE_OPTIONS = { repositoryId: "repo-1", commitSha: "sha1", attempt: 0, logger: noopLogger() as never };

describe("buildKnowledgeGraph — happy path", () => {
  it("extracts symbols, resolves a same-file/cross-file CALLS edge, EXTENDS, IMPORTS (RESOLVED/EXTERNAL/UNRESOLVED), and TESTS edges", async () => {
    const { rootDir, repoContext, graphFiles } = await setupFixture([
      { path: "src/util.ts", content: "export function helper(): number {\n  return 1;\n}\n" },
      {
        path: "src/caller.ts",
        content: 'import { helper } from "./util.js";\n\nexport function useHelper(): number {\n  return helper();\n}\n',
      },
      { path: "src/base.ts", content: "export class Base {\n  greet(): string {\n    return \"hi\";\n  }\n}\n" },
      { path: "src/derived.ts", content: 'import { Base } from "./base.js";\n\nexport class Derived extends Base {}\n' },
      { path: "src/uses-external.ts", content: 'import { z } from "zod";\n\nexport function useZod() {\n  return z;\n}\n' },
      { path: "src/uses-unresolved.ts", content: 'import { thing } from "./does-not-exist.js";\n\nexport function useThing() {\n  return thing;\n}\n' },
      {
        path: "src/caller.test.ts",
        content: 'import { useHelper } from "./caller.js";\n\nexport function runTest() {\n  return useHelper();\n}\n',
        isTest: true,
      },
    ]);

    const result = await buildKnowledgeGraph({ ...BASE_OPTIONS, rootDir, repoContext, files: graphFiles });

    expect(result.filesParsedOk).toBe(7);
    expect(result.parseFailureCount).toBe(0);
    expect(result.symbolsCreated).toBeGreaterThan(0);
    expect(result.edgesCreated).toBeGreaterThan(0);

    const byKind = (kind: string) => insertedEdges.filter((e) => e.kind === kind);

    // CALLS: useHelper -> helper, and runTest -> useHelper (from caller.test.ts).
    expect(byKind("CALLS")).toHaveLength(2);
    expect(byKind("CALLS").every((e) => e.confidence > 0)).toBe(true);

    // EXTENDS: Derived -> Base.
    expect(byKind("EXTENDS")).toHaveLength(1);

    // IMPORTS across all three resolutions.
    const imports = byKind("IMPORTS");
    expect(imports.some((e) => e.resolution === "RESOLVED" && e.toFileId !== null)).toBe(true);
    expect(imports.some((e) => e.resolution === "EXTERNAL" && e.externalPackage === "zod")).toBe(true);
    expect(imports.some((e) => e.resolution === "UNRESOLVED" && e.rawSpecifier === "./does-not-exist.js")).toBe(true);

    // TESTS: caller.test.ts -> caller.ts (not to any test file).
    const tests = byKind("TESTS");
    expect(tests).toHaveLength(1);

    // CONTAINS — one per symbol.
    expect(byKind("CONTAINS").length).toBe(result.symbolsCreated);
  });

  it("deletes edges before symbols (full-replace ordering)", async () => {
    const { rootDir, repoContext, graphFiles } = await setupFixture([{ path: "src/a.ts", content: "export const x = 1;\n" }]);

    await buildKnowledgeGraph({ ...BASE_OPTIONS, rootDir, repoContext, files: graphFiles });

    const deleteEdgesIdx = callOrder.indexOf("deleteCodeDependenciesByRepository");
    const deleteSymbolsIdx = callOrder.indexOf("deleteCodeSymbolsByRepository");
    expect(deleteEdgesIdx).toBeGreaterThanOrEqual(0);
    expect(deleteSymbolsIdx).toBeGreaterThanOrEqual(0);
    expect(deleteEdgesIdx).toBeLessThan(deleteSymbolsIdx);
  });
});

describe("buildKnowledgeGraph — a single malformed file cannot fail the run", () => {
  it("marks the malformed file FAILED, still extracts symbols from every other file, and never throws", async () => {
    const { rootDir, repoContext, graphFiles } = await setupFixture([
      { path: "src/ok.ts", content: "export function fine(): number {\n  return 1;\n}\n" },
      // The exact malformed fixture prompt 2's own golden-file suite verified crosses the
      // 10% error-node tolerance ratio (docs/decisions/phase-04-log.md, Prompt 2 §5).
      { path: "src/broken.ts", content: "// deliberately broken (§14)\nexport function calculateTotal(items {\n  return items" },
    ]);

    const result = await buildKnowledgeGraph({ ...BASE_OPTIONS, rootDir, repoContext, files: graphFiles });

    expect(result.parseFailureCount).toBe(1);
    expect(result.filesParsedOk).toBe(1);
    // The healthy file's symbol still made it through.
    const symbolCalls = insertCodeSymbols.mock.calls.flatMap(([rows]) => rows as CodeSymbolInsertInput[]);
    expect(symbolCalls.some((s) => s.name === "fine")).toBe(true);
    expect(symbolCalls.some((s) => s.name === "calculateTotal")).toBe(false);
  });

  it("continues past a file that cannot even be read from disk", async () => {
    const { rootDir, repoContext, graphFiles } = await setupFixture([{ path: "src/ok.ts", content: "export function fine(): number {\n  return 1;\n}\n" }]);
    const brokenFiles = [...graphFiles, { id: "file-missing", path: "src/missing.ts", indexState: "INDEXED" as const, isTest: false }];

    const result = await buildKnowledgeGraph({ ...BASE_OPTIONS, rootDir, repoContext, files: brokenFiles });

    expect(result.parseFailureCount).toBe(1);
    expect(result.filesParsedOk).toBe(1);
  });
});

describe("buildKnowledgeGraph — NOT_PARSED files", () => {
  it("never opens a SKIPPED or wrong-language file, and gives it parseState NOT_PARSED", async () => {
    const rootDir = await makeTempRoot();
    await writeFile(rootDir, "README.md", "# hello\n");
    const repoContext = await buildRepoContext(rootDir, ["README.md"]);
    const files = [{ id: "file-readme", path: "README.md", indexState: "INDEXED" as const, isTest: false }];

    const result = await buildKnowledgeGraph({ ...BASE_OPTIONS, rootDir, repoContext, files });

    expect(result.filesNotParsed).toBe(1);
    expect(result.filesParsedOk).toBe(0);
    expect(insertCodeSymbols).not.toHaveBeenCalled();
  });

  it("never opens a file whose indexState is not INDEXED", async () => {
    const { rootDir, repoContext } = await setupFixture([{ path: "src/skipped.ts", content: "export const x = 1;\n" }]);
    const files = [{ id: "file-1", path: "src/skipped.ts", indexState: "SKIPPED" as const, isTest: false }];

    const result = await buildKnowledgeGraph({ ...BASE_OPTIONS, rootDir, repoContext, files });

    expect(result.filesNotParsed).toBe(1);
    expect(insertCodeSymbols).not.toHaveBeenCalled();
  });
});

describe("batchSizeForAttempt", () => {
  it("shrinks the batch size as the attempt number rises", () => {
    expect(batchSizeForAttempt(0)).toBe(200);
    expect(batchSizeForAttempt(1)).toBe(100);
    expect(batchSizeForAttempt(2)).toBe(50);
    expect(batchSizeForAttempt(5)).toBe(50);
  });

  it("actually engages: a smaller attempt-aware batch size produces more insertCodeSymbols flushes for the same file count", async () => {
    // 120 real tree-sitter parses run twice in this test; give it real headroom under
    // full-suite resource contention rather than the file's 5s default.
    // 60 files: attempt 0 (batch size 200) fits in one flush; attempt 2 (batch size 50)
    // needs two (50 + 10) — a real, observable difference, not just the sizing function
    // in isolation.
    const files: FixtureFile[] = Array.from({ length: 60 }, (_, i) => ({
      path: `src/f${i.toString()}.ts`,
      content: `export function fn${i.toString()}(): number {\n  return ${i.toString()};\n}\n`,
    }));
    const { rootDir, repoContext, graphFiles } = await setupFixture(files);

    await buildKnowledgeGraph({ ...BASE_OPTIONS, attempt: 0, rootDir, repoContext, files: graphFiles });
    const flushesAtAttempt0 = insertCodeSymbols.mock.calls.length;
    insertCodeSymbols.mockClear();

    await buildKnowledgeGraph({ ...BASE_OPTIONS, attempt: 2, rootDir, repoContext, files: graphFiles });
    const flushesAtAttempt2 = insertCodeSymbols.mock.calls.length;

    expect(flushesAtAttempt0).toBe(1);
    expect(flushesAtAttempt2).toBe(2);
  }, 20_000);
});
