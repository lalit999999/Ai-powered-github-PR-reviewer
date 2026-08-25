import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as tarStream from "tar-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryFileUpsertInput } from "./persistence/repository-file.repository.js";
import type { TarballFetchResult } from "./fetcher/tarball-fetcher.js";

/**
 * §14 Automated Verification: "Ignore-rule tests against fixture repositories, including
 * a monorepo fixture with `node_modules` committed." `ignore-rules.test.ts`/
 * `walk-tree.test.ts` already exercise every individual rule and heuristic in isolation
 * against a real temp directory; this file is the end-to-end complement Prompt 3 adds —
 * whole, synthetic repository trees, built programmatically and tar+gzip'd in memory
 * (never a real file on disk, and never a real repository's content), driven through
 * `indexRepository`'s **real** fetch→extract→walk pipeline exactly as production runs it,
 * with only the persistence layer mocked (matching indexer.service.test.ts's own
 * convention — `*.repository.ts` files get real Postgres coverage in Prompt 3's
 * integration suite, never a unit mock standing in for correctness).
 *
 * What this file proves that the per-function unit tests cannot: the **filter order** is
 * observable end to end through the real composed pipeline (not just "each stage is
 * correct in isolation" — a wiring mistake in indexer.service.ts itself would not show up
 * in walk-tree.test.ts, which calls walkTree directly), and a set of **near-miss paths**
 * that look like a hard-ignore pattern but are not one survive indexing rather than being
 * silently swallowed by an over-eager glob.
 */

const upsertRepositoryFiles = vi.fn(async (_files: RepositoryFileUpsertInput[]) => undefined);
const sweepStaleRepositoryFiles = vi.fn(async (_repositoryId: string, _sha: string) => 0);
vi.mock("./persistence/repository-file.repository.js", () => ({
  upsertRepositoryFiles: (files: RepositoryFileUpsertInput[]) => upsertRepositoryFiles(files),
  sweepStaleRepositoryFiles: (repositoryId: string, sha: string) => sweepStaleRepositoryFiles(repositoryId, sha),
}));

const { indexRepository } = await import("./indexer.service.js");

const TOP_LEVEL = "octocat-fixture-repo-1a2b3c4";

function spyLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface FixtureEntry {
  header: tarStream.Headers;
  content?: string | Buffer;
}

async function buildTarballGzip(entries: FixtureEntry[]): Promise<Buffer> {
  const pack = tarStream.pack();
  for (const entry of entries) {
    if (entry.content !== undefined) pack.entry(entry.header, entry.content);
    else pack.entry(entry.header);
  }
  pack.finalize();

  const chunks: Buffer[] = [];
  for await (const chunk of pack) {
    chunks.push(chunk as Buffer);
  }
  return gzipSync(Buffer.concat(chunks));
}

function toWebStream(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

/** Builds a tarball from a flat `{path: content}` map — every fixture in this file is
 * expressed this way, since none of them need directory entries or non-file types. */
function file(name: string, content: string | Buffer): FixtureEntry {
  return { header: { name: `${TOP_LEVEL}/${name}`, type: "file" }, content };
}

const tempRoots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repository-fixtures-test-"));
  tempRoots.push(dir);
  return dir;
}

function fakeFetchTarball(result: TarballFetchResult) {
  return vi.fn(async () => result);
}

async function runFixture(entries: FixtureEntry[], overrides: Partial<Parameters<typeof indexRepository>[0]> = {}) {
  const buffer = await buildTarballGzip(entries);
  const logger = overrides.logger ?? spyLogger();
  const result = await indexRepository({
    installationId: 1n,
    owner: "octocat",
    repo: "fixture-repo",
    sha: "abc123",
    repositoryId: "repo-fixture",
    jobId: "job-fixture",
    tempRootDir: await makeTempRoot(),
    maxTotalBytes: 50 * 1024 * 1024,
    maxFileCount: 10_000,
    ...overrides,
    logger: logger as never,
    fetchTarball: fakeFetchTarball({ ok: true, stream: toWebStream(buffer) }) as never,
  });
  const persisted = upsertRepositoryFiles.mock.calls.at(-1)?.[0] as RepositoryFileUpsertInput[] | undefined;
  return { result, persisted: persisted ?? [], logger };
}

function byPath(persisted: RepositoryFileUpsertInput[], relativePath: string) {
  return persisted.find((f) => f.path === relativePath);
}

describe("fixture repositories — the ordinary project", () => {
  it("indexes source/test/config/docs correctly and hard-ignores the lockfile with no row", async () => {
    const { result, persisted } = await runFixture([
      file("package.json", '{"name":"fixture","version":"1.0.0"}\n'),
      file("tsconfig.json", '{"compilerOptions":{}}\n'),
      file("README.md", "# Fixture\n"),
      file("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"),
      file("src/index.ts", "export const main = () => 1;\n"),
      file("src/index.test.ts", "import { main } from './index.js';\ntest('ok', () => main());\n"),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    // pnpm-lock.yaml matches HARD_IGNORE_PATTERNS' "pnpm-lock.yaml" entry — no row at all.
    expect(byPath(persisted, "pnpm-lock.yaml")).toBeUndefined();
    expect(persisted).toHaveLength(5);

    expect(byPath(persisted, "package.json")).toMatchObject({ classification: "CONFIG", indexState: "INDEXED" });
    expect(byPath(persisted, "tsconfig.json")).toMatchObject({ classification: "CONFIG", indexState: "INDEXED" });
    expect(byPath(persisted, "README.md")).toMatchObject({ classification: "DOCUMENTATION", indexState: "INDEXED" });
    expect(byPath(persisted, "src/index.ts")).toMatchObject({ classification: "SOURCE", indexState: "INDEXED", isTest: false });
    expect(byPath(persisted, "src/index.test.ts")).toMatchObject({ classification: "TEST", indexState: "INDEXED", isTest: true });

    expect(result.hardIgnoredCount).toBe(1);
    expect(result.filesTotal).toBe(5);
    expect(result.filesProcessed + result.filesSkipped).toBe(result.filesTotal);
  });
});

describe("fixture repositories — the monorepo with node_modules committed", () => {
  it("removes the bulk of the tree via hard-ignore and fires the repository health note", async () => {
    const entries: FixtureEntry[] = [];
    // 150 committed node_modules files across 30 packages — the real, observed case
    // (plan.md §43.2) that can be up to 90% of a repository's raw file count.
    for (let pkg = 0; pkg < 30; pkg += 1) {
      entries.push(file(`node_modules/dep-${pkg.toString()}/package.json`, `{"name":"dep-${pkg.toString()}"}\n`));
      entries.push(file(`node_modules/dep-${pkg.toString()}/index.js`, "module.exports = {};\n"));
      entries.push(file(`node_modules/dep-${pkg.toString()}/lib/util.js`, "module.exports.util = 1;\n"));
      entries.push(file(`node_modules/dep-${pkg.toString()}/lib/helpers.js`, "module.exports.helpers = 1;\n"));
      entries.push(file(`node_modules/dep-${pkg.toString()}/README.md`, "# dep\n"));
    }
    // 20 genuine application files.
    for (let i = 0; i < 20; i += 1) {
      entries.push(file(`packages/app/src/module-${i.toString()}.ts`, `export const v${i.toString()} = ${i.toString()};\n`));
    }

    const logger = spyLogger();
    const { result, persisted } = await runFixture(entries, { logger: logger as never });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    // 150 node_modules files never get a row; only the 20 app files do.
    expect(persisted).toHaveLength(20);
    expect(persisted.every((f) => !f.path.startsWith("node_modules/"))).toBe(true);
    expect(result.filesTotal).toBe(20);
    expect(result.hardIgnoredCount).toBe(150);
    expect(result.hardIgnoreRatio).toBeCloseTo(150 / 170, 3);

    // §16/§22: the repository-health note — a distinct, greppable warn line, not silently
    // absorbed into the ordinary completion log.
    const warnCalls = logger.warn.mock.calls as [string, ...unknown[]][];
    const healthNote = warnCalls.find(([message]) => message.includes("repository health note"));
    expect(healthNote).toBeDefined();
  });
});

describe("fixture repositories — .gitattributes generated/vendored, and the filter order proven end to end", () => {
  it("skips a .gitattributes-vendored path via SKIPPED_VENDORED, never reaching the binary check that would otherwise fire", async () => {
    // A NUL byte in the first 8KB would trip detectBinary (file-classifier.ts) if the
    // binary check ever ran on this file — it must not, because classifyIgnore's
    // .gitattributes stage runs first and short-circuits it. If a future edit reordered
    // the pipeline, this file would come back SKIPPED_BINARY instead of SKIPPED_VENDORED
    // and this assertion would catch it.
    const vendoredBinaryContent = Buffer.concat([Buffer.from("start"), Buffer.from([0x00]), Buffer.from("rest")]);

    const { result, persisted } = await runFixture([
      file(".gitattributes", "vendored/** linguist-vendored\n**/*.pb.go linguist-generated\n"),
      file("vendored/blob.dat", vendoredBinaryContent),
      file("api/v1/service.pb.go", "// generated, do not edit\npackage v1\n"),
      file("src/real.go", "package main\nfunc main() {}\n"),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(byPath(persisted, "vendored/blob.dat")).toMatchObject({ indexState: "SKIPPED", skipReason: "SKIPPED_VENDORED" });
    // The bare `**/*.pb.go` pattern must match a nested path (git-attributes anchoring,
    // not just a root-level match) — a real-world regression this codebase already found
    // once (docs/decisions/phase-03-log.md §3 of the Prompt 2 log).
    expect(byPath(persisted, "api/v1/service.pb.go")).toMatchObject({ indexState: "SKIPPED", skipReason: "SKIPPED_GENERATED" });
    expect(byPath(persisted, "src/real.go")).toMatchObject({ indexState: "INDEXED" });
  });

  it("hard-ignore precedes the size cap: an oversized file under dist/ gets no row, not a SKIPPED_TOO_LARGE one", async () => {
    const oversized = "a".repeat(600 * 1024); // over the 512 KB cap

    const { result, persisted } = await runFixture([file("dist/bundle.js", oversized), file("src/app.ts", "export {};\n")]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(byPath(persisted, "dist/bundle.js")).toBeUndefined();
    expect(persisted).toHaveLength(1);
    expect(result.hardIgnoredCount).toBe(1);
    expect(result.filesTotal).toBe(1);
  });
});

describe("fixture repositories — near-miss paths that must survive indexing", () => {
  it("does not hard-ignore filenames that merely resemble an ignored pattern", async () => {
    const { result, persisted } = await runFixture([
      file("my-node_modules-helper.ts", "export const helper = 1;\n"),
      file("dist-utils.ts", "export const utils = 1;\n"),
      file("package-lock-parser.ts", "export const parse = () => null;\n"),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(result.hardIgnoredCount).toBe(0);
    expect(persisted).toHaveLength(3);
    for (const p of ["my-node_modules-helper.ts", "dist-utils.ts", "package-lock-parser.ts"]) {
      expect(byPath(persisted, p)).toMatchObject({ indexState: "INDEXED", classification: "SOURCE" });
    }
  });
});
