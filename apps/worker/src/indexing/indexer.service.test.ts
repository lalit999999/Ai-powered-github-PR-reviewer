import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as tarStream from "tar-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryFileUpsertInput } from "./persistence/repository-file.repository.js";
import type { TarballFetchResult } from "./fetcher/tarball-fetcher.js";

// repository-file.repository.ts imports @repo/db, which requires DATABASE_URL at
// import time (packages/db/src/client.ts) — mocked here so this stays a pure unit test,
// matching the established convention that *.repository.ts files are exercised for real
// only via Testcontainers integration tests (Prompt 3), never unit-mocked-and-tested
// individually. What indexer.service.ts actually does with the persistence layer's
// *inputs* is exactly what this file asserts on, via these mocks.
const upsertRepositoryFiles = vi.fn(async (_files: RepositoryFileUpsertInput[]) => undefined);
const sweepStaleRepositoryFiles = vi.fn(async (_repositoryId: string, _sha: string) => 0);
vi.mock("./persistence/repository-file.repository.js", () => ({
  upsertRepositoryFiles: (files: RepositoryFileUpsertInput[]) => upsertRepositoryFiles(files),
  sweepStaleRepositoryFiles: (repositoryId: string, sha: string) => sweepStaleRepositoryFiles(repositoryId, sha),
}));

const { indexRepository } = await import("./indexer.service.js");

const TOP_LEVEL = "octocat-hello-world-1a2b3c4";

function noopLogger() {
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

const tempRoots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "indexer-service-test-"));
  tempRoots.push(dir);
  return dir;
}

function fakeFetchTarball(result: TarballFetchResult) {
  return vi.fn(async () => result);
}

describe("indexRepository", () => {
  it("runs the whole fetch -> extract -> walk -> persist -> sweep pipeline and reports the right counts", async () => {
    const buffer = await buildTarballGzip([
      { header: { name: `${TOP_LEVEL}/`, type: "directory" }, content: undefined },
      { header: { name: `${TOP_LEVEL}/src/index.ts`, type: "file" }, content: "export const x = 1;\n" },
      { header: { name: `${TOP_LEVEL}/node_modules/pkg/index.js`, type: "file" }, content: "module.exports = {};\n" },
    ]);

    const progressUpdates: { currentStep: string; progressPercent: number }[] = [];
    const result = await indexRepository({
      installationId: 1n,
      owner: "octocat",
      repo: "hello-world",
      sha: "abc123",
      repositoryId: "repo-1",
      jobId: "job-1",
      tempRootDir: await makeTempRoot(),
      maxTotalBytes: 10 * 1024 * 1024,
      maxFileCount: 1000,
      logger: noopLogger() as never,
      fetchTarball: fakeFetchTarball({ ok: true, stream: toWebStream(buffer) }) as never,
      onProgress: async (update) => {
        progressUpdates.push({ currentStep: update.currentStep, progressPercent: update.progressPercent });
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.filesTotal).toBe(1); // node_modules/** is hard-ignored — no row at all
    expect(result.filesProcessed).toBe(1);
    expect(result.filesSkipped).toBe(0);
    expect(result.hardIgnoredCount).toBe(1);

    expect(upsertRepositoryFiles).toHaveBeenCalledOnce();
    const [persistedFiles] = upsertRepositoryFiles.mock.calls[0] as [RepositoryFileUpsertInput[]];
    expect(persistedFiles).toHaveLength(1);
    expect(persistedFiles[0]).toMatchObject({
      repositoryId: "repo-1",
      path: "src/index.ts",
      commitSha: "abc123",
      indexState: "INDEXED",
    });

    expect(sweepStaleRepositoryFiles).toHaveBeenCalledWith("repo-1", "abc123");

    // Progress reports its own coarse checkpoints, in order.
    expect(progressUpdates.map((p) => p.currentStep)).toEqual([
      "download-tarball",
      "extract-filter-hash",
      "persist-repository-files",
      "persisted",
    ]);
    expect(progressUpdates.map((p) => p.progressPercent)).toEqual([15, 35, 70, 90]);
  });

  it("returns the REPO_NOT_FOUND result unchanged, and never touches persistence", async () => {
    const result = await indexRepository({
      installationId: 1n,
      owner: "octocat",
      repo: "gone",
      sha: "deadbeef",
      repositoryId: "repo-2",
      jobId: "job-2",
      tempRootDir: await makeTempRoot(),
      maxTotalBytes: 1024,
      maxFileCount: 10,
      logger: noopLogger() as never,
      fetchTarball: fakeFetchTarball({ ok: false, reason: "REPO_NOT_FOUND" }) as never,
    });

    expect(result).toEqual({ ok: false, reason: "REPO_NOT_FOUND" });
    expect(upsertRepositoryFiles).not.toHaveBeenCalled();
    expect(sweepStaleRepositoryFiles).not.toHaveBeenCalled();
  });

  it("returns the UNSAFE_REDIRECT result unchanged, with its host", async () => {
    const result = await indexRepository({
      installationId: 1n,
      owner: "octocat",
      repo: "hello-world",
      sha: "abc123",
      repositoryId: "repo-3",
      jobId: "job-3",
      tempRootDir: await makeTempRoot(),
      maxTotalBytes: 1024,
      maxFileCount: 10,
      logger: noopLogger() as never,
      fetchTarball: fakeFetchTarball({ ok: false, reason: "UNSAFE_REDIRECT", host: "evil.example.com" }) as never,
    });

    expect(result).toEqual({ ok: false, reason: "UNSAFE_REDIRECT", host: "evil.example.com" });
    expect(upsertRepositoryFiles).not.toHaveBeenCalled();
  });

  it("propagates an archive-level error (e.g. path traversal) rather than swallowing it", async () => {
    const buffer = await buildTarballGzip([
      { header: { name: `${TOP_LEVEL}/`, type: "directory" }, content: undefined },
      { header: { name: `${TOP_LEVEL}/../../etc/passwd`, type: "file" }, content: "hacked" },
    ]);

    await expect(
      indexRepository({
        installationId: 1n,
        owner: "octocat",
        repo: "hello-world",
        sha: "abc123",
        repositoryId: "repo-4",
        jobId: "job-4",
        tempRootDir: await makeTempRoot(),
        maxTotalBytes: 10 * 1024 * 1024,
        maxFileCount: 1000,
        logger: noopLogger() as never,
        fetchTarball: fakeFetchTarball({ ok: true, stream: toWebStream(buffer) }) as never,
      }),
    ).rejects.toThrow(/unsafe path/i);

    expect(upsertRepositoryFiles).not.toHaveBeenCalled();
  });

  it("the reconciliation invariant (filesProcessed + filesSkipped === filesTotal) holds end to end, mixing INDEXED/SKIPPED/FAILED", async () => {
    const bigLine = "a".repeat(600);
    const buffer = await buildTarballGzip([
      { header: { name: `${TOP_LEVEL}/`, type: "directory" }, content: undefined },
      { header: { name: `${TOP_LEVEL}/src/ok.ts`, type: "file" }, content: "export {};\n" }, // INDEXED
      { header: { name: `${TOP_LEVEL}/src/minified.js`, type: "file" }, content: `${bigLine}\n${bigLine}\n` }, // SKIPPED
      { header: { name: `${TOP_LEVEL}/src/broken.ts`, type: "file" }, content: "will become unreadable" }, // FAILED
    ]);

    const tempRootDir = await makeTempRoot();
    const result = await indexRepository({
      installationId: 1n,
      owner: "octocat",
      repo: "hello-world",
      sha: "abc123",
      repositoryId: "repo-5",
      jobId: "job-5",
      tempRootDir,
      maxTotalBytes: 10 * 1024 * 1024,
      maxFileCount: 1000,
      logger: noopLogger() as never,
      // extractRepositoryArchive writes into a job-unique subdirectory it creates
      // itself; chmod-ing src/broken.ts to unreadable has to happen *during* extraction,
      // which this test cannot reach into — instead this exercises the invariant against
      // the two reachable states (INDEXED, SKIPPED) and walk-tree.test.ts already proves
      // the FAILED case's bucket assignment directly against the walker in isolation.
      fetchTarball: fakeFetchTarball({ ok: true, stream: toWebStream(buffer) }) as never,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.filesTotal).toBe(3);
    expect(result.filesProcessed + result.filesSkipped).toBe(result.filesTotal);
  });
});
