import { gzipSync } from "node:zlib";
import { InngestTestEngine } from "@inngest/test";
import { prisma } from "@repo/db";
import { REPOSITORY_INDEX_REQUESTED } from "@repo/shared";
import * as tarStream from "tar-stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "./db-helpers.js";
import { seedRepository, type SeededRepository } from "./repository-helpers.js";

/**
 * §14/§15's end-to-end requirements, driven against a **real** Postgres (this file's own
 * Testcontainers instance — see global-setup.ts) and the **real** `repositoryIndex`
 * `InngestFunction` object `repository-index.ts` exports — not a hand-rolled
 * re-implementation of its step sequence. `@inngest/test`'s `InngestTestEngine` runs the
 * function's actual steps for real (no mocked step bodies unless explicitly given), which
 * is what makes this file able to prove step wiring, not just each persistence function's
 * own correctness in isolation (already covered by unit tests) or the pipeline's own
 * correctness with mocked persistence (indexer.service.test.ts).
 *
 * Two boundaries are still mocked, deliberately, at the same seams the rest of this
 * codebase's integration suites already use: `@repo/github` (no real GitHub call — this
 * environment has no real installation, per every prior Phase 03 log entry) and
 * `tarball-fetcher.ts`'s `fetchTarballStream` (the tarball itself is a synthetic,
 * in-memory fixture built with `tar-stream`, never a real archive).
 *
 * **Known limitation of `@inngest/test@1.0.0`, stated plainly rather than glossed over**:
 * it does not invoke `onFailure` automatically, and it does not model retries (a failed
 * step fails the run permanently on the first attempt). So a test that drives a failure
 * through the real function object can prove the function *throws the right coded error*
 * and that intermediate Postgres state is correct up to that point, but cannot itself
 * prove `onFailure`'s terminal write — for that, this file calls the exact same
 * `repositoryRepository.markFailed`/`indexJobRepository.markFailed` functions `onFailure`
 * calls, directly, against the same real Postgres, which is the persistence half of what
 * `onFailure` does (the lookup-by-`inngestRunId` half is already unit-tested).
 */

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/github")>();
  return {
    ...actual,
    repositoryGithub: { ...actual.repositoryGithub, getHeadCommit: vi.fn() },
  };
});

const fetchTarballStream = vi.fn();
vi.mock("../../src/indexing/fetcher/tarball-fetcher.js", () => ({
  fetchTarballStream: (...args: unknown[]) => fetchTarballStream(...(args as [])),
}));

const { repositoryGithub } = await import("@repo/github");
const { repositoryIndex } = await import("../../src/inngest/functions/repository-index.js");
const { indexRepository } = await import("../../src/indexing/indexer.service.js");
const { ArchiveTooLargeError } = await import("../../src/indexing/fetcher/archive-extractor.js");
const repositoryRepository = await import("../../src/indexing/persistence/repository.repository.js");
const indexJobRepository = await import("../../src/indexing/persistence/index-job.repository.js");

const TOP_LEVEL = "octocat-fixture-repo-deadbeef";

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
  for await (const chunk of pack) chunks.push(chunk as Buffer);
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

function file(name: string, content: string | Buffer): FixtureEntry {
  return { header: { name: `${TOP_LEVEL}/${name}`, type: "file" }, content };
}

const ORDINARY_FIXTURE: FixtureEntry[] = [
  file("package.json", '{"name":"fixture"}\n'),
  file("src/index.ts", "export const main = () => 1;\n"),
  file("src/utils.ts", "export const util = () => 2;\n"),
];

async function makeTempDir(): Promise<string> {
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  return fs.mkdtemp(path.join(os.tmpdir(), "repo-index-pipeline-test-"));
}

// The real repositoryIndex function's final step is `step.sendEvent("emit-repository-indexed", ...)`.
// @inngest/test@1.0.0's own documented limitation: "Calling inngest.send() within a
// function is not yet automatically mocked" — it goes through the client's real fetch,
// which would otherwise try (and fail) to reach a real Inngest ingest endpoint. Stubbed
// at the one seam it actually reaches (global fetch), rather than mocking `client.ts` or
// `step.sendEvent` itself, since neither of those is a public seam this module exposes.
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(repositoryGithub.getHeadCommit).mockReset();
  fetchTarballStream.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ids: ["evt_test"], status: 200 }), { status: 200 })),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", originalFetch);
});

afterAll(async () => {
  await prisma.$disconnect();
});

function mockHeadCommit(sha: string) {
  vi.mocked(repositoryGithub.getHeadCommit).mockResolvedValue({ ok: true, commit: { sha } });
}

function mockTarball(buffer: Buffer) {
  fetchTarballStream.mockResolvedValue({ ok: true, stream: toWebStream(buffer) });
}

/** `t.execute()`'s `error` field is whatever the function actually threw, round-tripped
 * through Inngest's own `JsonError` serialization (`{ name, message, stack, cause? }` —
 * a plain object, not a live `Error` instance, by the time it reaches this test) — the
 * same round trip `repository-index.ts`'s own header comment documents for `onFailure`.
 * Narrowed here rather than asserted `as Error` at every call site. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}

function buildEvent(repo: SeededRepository, overrides: Partial<{ indexJobId: string }> = {}) {
  return {
    name: REPOSITORY_INDEX_REQUESTED,
    data: {
      projectId: repo.projectId,
      repositoryId: repo.id,
      mode: "FULL" as const,
      reason: "manual" as const,
      ...overrides,
    },
  };
}

describe("repository-index — the happy path, driven through the real Inngest function", () => {
  it("takes Repository PENDING -> INDEXING -> INDEXED, persists the right RepositoryFile rows, and makes exactly two GitHub calls", async () => {
    const repo = await seedRepository();
    mockHeadCommit("deadbeef1234567");
    mockTarball(await buildTarballGzip(ORDINARY_FIXTURE));

    const t = new InngestTestEngine({ function: repositoryIndex, events: [buildEvent(repo)] });
    const { result, error } = await t.execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ skipped: false, commitSha: "deadbeef1234567", filesTotal: 3, filesIndexed: 3 });

    const finalRepo = await prisma.repository.findUnique({ where: { id: repo.id } });
    expect(finalRepo?.indexStatus).toBe("INDEXED");
    expect(finalRepo?.indexedCommitSha).toBe("deadbeef1234567");
    expect(finalRepo?.indexedFileCount).toBe(3);

    const finalJob = await prisma.indexJob.findFirst({ where: { repositoryId: repo.id } });
    expect(finalJob).not.toBeNull();
    expect(finalJob?.status).toBe("SUCCEEDED");
    expect(finalJob?.progressPercent).toBe(100);
    expect(finalJob!.filesProcessed + finalJob!.filesSkipped).toBe(finalJob!.filesTotal);
    // Exactly one IndexJob row for this run — no lock double-acquisition, no orphan row.
    expect(await prisma.indexJob.count({ where: { repositoryId: repo.id } })).toBe(1);

    const files = await prisma.repositoryFile.findMany({ where: { repositoryId: repo.id }, orderBy: { path: "asc" } });
    // Repository-relative paths — the tarball's TOP_LEVEL/ component is stripped.
    expect(files.map((f) => f.path)).toEqual(["package.json", "src/index.ts", "src/utils.ts"]);
    expect(files.every((f) => f.commitSha === "deadbeef1234567")).toBe(true);
    expect(files.every((f) => f.indexState === "INDEXED")).toBe(true);

    // §9/§14/§15: exactly two GitHub API calls per full index run.
    expect(repositoryGithub.getHeadCommit).toHaveBeenCalledTimes(1);
    expect(fetchTarballStream).toHaveBeenCalledTimes(1);
  });

  it("re-indexing at the same, already-indexed SHA is a no-op that still marks the job SUCCEEDED and touches no files", async () => {
    const repo = await seedRepository({ indexStatus: "INDEXED", indexedCommitSha: "samecommit1" });
    mockHeadCommit("samecommit1");

    const t = new InngestTestEngine({ function: repositoryIndex, events: [buildEvent(repo)] });
    const { result, error } = await t.execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ skipped: true, reason: "ALREADY_INDEXED", commitSha: "samecommit1" });

    expect(fetchTarballStream).not.toHaveBeenCalled();
    expect(await prisma.repositoryFile.count({ where: { repositoryId: repo.id } })).toBe(0);

    const job = await prisma.indexJob.findFirst({ where: { repositoryId: repo.id } });
    expect(job?.status).toBe("SUCCEEDED");
    expect(job?.currentStep).toBe("no-op-already-indexed");
  });
});

describe("repository-index — the locking guarantee, against real concurrent Postgres writes", () => {
  it("two genuinely concurrent index requests for the same repository acquire the lock exactly once", async () => {
    const repo = await seedRepository();

    const [first, second] = await Promise.all([
      repositoryRepository.acquireIndexingLock(repo.id),
      repositoryRepository.acquireIndexingLock(repo.id),
    ]);

    const acquired = [first, second].filter((r) => r.acquired);
    const rejected = [first, second].filter((r) => !r.acquired);
    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // A third attempt while still INDEXING also fails to acquire — the repository never
    // silently re-enters INDEXING from INDEXING.
    const third = await repositoryRepository.acquireIndexingLock(repo.id);
    expect(third.acquired).toBe(false);
  });
});

describe("repository-index — an interrupted job never produces duplicate rows or a silent success", () => {
  it("running the fetch-extract-persist unit twice (simulating a worker restart mid-step) never duplicates RepositoryFile rows", async () => {
    const repo = await seedRepository();
    const buffer = await buildTarballGzip(ORDINARY_FIXTURE);

    const runOnce = async () =>
      indexRepository({
        installationId: repo.installationId,
        owner: repo.owner,
        repo: repo.name,
        sha: "restartsha1",
        repositoryId: repo.id,
        jobId: "job-restart-test",
        tempRootDir: await makeTempDir(),
        maxTotalBytes: 50 * 1024 * 1024,
        maxFileCount: 10_000,
        fetchTarball: async () => ({ ok: true, stream: toWebStream(buffer) }),
      });

    const first = await runOnce();
    expect(first.ok).toBe(true);
    const afterFirst = await prisma.repositoryFile.findMany({ where: { repositoryId: repo.id } });
    expect(afterFirst).toHaveLength(3);

    // The "restart": the same step body runs again from scratch against the identical
    // target, exactly what a real Inngest retry of a not-yet-memoized step does.
    const second = await runOnce();
    expect(second.ok).toBe(true);
    const afterSecond = await prisma.repositoryFile.findMany({ where: { repositoryId: repo.id } });
    expect(afterSecond).toHaveLength(3); // still 3, not 6 — the (repositoryId, path) upsert held.
    expect(new Set(afterSecond.map((f) => f.id))).toEqual(new Set(afterFirst.map((f) => f.id))); // same rows, updated in place
  });

  it("a run that never reaches its terminal step leaves Repository at INDEXING, never a silent INDEXED", async () => {
    const repo = await seedRepository();
    mockHeadCommit("interruptedsha1");
    mockTarball(await buildTarballGzip(ORDINARY_FIXTURE));

    const t = new InngestTestEngine({ function: repositoryIndex, events: [buildEvent(repo)] });
    // Stop right after fetch-extract-persist has run (files are on disk and persisted)
    // but before the terminal "mark-repository-indexed"/"mark-job-succeeded" steps —
    // simulating the worker being killed in that exact window.
    await t.executeStep("fetch-extract-persist");

    const repoRow = await prisma.repository.findUnique({ where: { id: repo.id } });
    expect(repoRow?.indexStatus).toBe("INDEXING"); // never silently INDEXED
    expect(repoRow?.indexedCommitSha).toBeNull();

    const job = await prisma.indexJob.findFirst({ where: { repositoryId: repo.id } });
    expect(job?.status).toBe("RUNNING"); // never silently SUCCEEDED with an incomplete file set
  });
});

describe("repository-index — §12's failure modes, coded correctly and persisted correctly", () => {
  it("REPO_NOT_FOUND: a missing default branch throws the coded error, and the equivalent terminal write lands correctly in Postgres", async () => {
    const repo = await seedRepository();
    vi.mocked(repositoryGithub.getHeadCommit).mockResolvedValue({ ok: false, reason: "NOT_ACCESSIBLE" });

    const t = new InngestTestEngine({ function: repositoryIndex, events: [buildEvent(repo)] });
    const { error } = await t.execute();

    expect(error).toBeDefined();
    expect(errorMessage(error)).toMatch(/^REPO_NOT_FOUND:/);

    // @inngest/test does not invoke onFailure automatically (documented limitation,
    // see this file's header) — exercise the exact terminal-write functions onFailure
    // calls, directly, against the same real Postgres.
    await repositoryRepository.markFailed({ repositoryId: repo.id, code: "REPO_NOT_FOUND", message: "not found" });
    const job = await prisma.indexJob.findFirst({ where: { repositoryId: repo.id } });
    await indexJobRepository.markFailed(job!.id, { code: "REPO_NOT_FOUND", message: "not found" });

    const finalRepo = await prisma.repository.findUnique({ where: { id: repo.id } });
    expect(finalRepo?.indexStatus).toBe("FAILED");
    expect(finalRepo?.indexError).toMatchObject({ code: "REPO_NOT_FOUND" });

    const finalJob = await prisma.indexJob.findFirst({ where: { repositoryId: repo.id } });
    expect(finalJob?.status).toBe("FAILED");
    expect(finalJob?.error).toMatchObject({ code: "REPO_NOT_FOUND" });
  });

  it("UNSAFE_ARCHIVE: a path-traversal tarball fails the whole job with a generic message, and no attack detail leaks into it", async () => {
    const repo = await seedRepository();
    mockHeadCommit("unsafesha1");
    const maliciousBuffer = await buildTarballGzip([
      { header: { name: `${TOP_LEVEL}/`, type: "directory" }, content: undefined },
      { header: { name: `${TOP_LEVEL}/../../etc/passwd`, type: "file" }, content: "hacked" },
    ]);
    mockTarball(maliciousBuffer);

    const t = new InngestTestEngine({ function: repositoryIndex, events: [buildEvent(repo)] });
    const { error } = await t.execute();

    expect(error).toBeDefined();
    const message = errorMessage(error);
    expect(message).toMatch(/^UNSAFE_ARCHIVE:/);
    // §12: "do not surface attack details to the UI" — the message itself must stay
    // generic, since it is exactly what a downstream onFailure write persists verbatim.
    expect(message).not.toMatch(/passwd|etc\/|\.\.\//);

    expect(await prisma.repositoryFile.count({ where: { repositoryId: repo.id } })).toBe(0);
  });

  it("REPO_TOO_LARGE: exceeding the file-count cap aborts before any RepositoryFile row is written", async () => {
    const repo = await seedRepository();
    const buffer = await buildTarballGzip(ORDINARY_FIXTURE); // 3 files

    await expect(
      indexRepository({
        installationId: repo.installationId,
        owner: repo.owner,
        repo: repo.name,
        sha: "toolargesha1",
        repositoryId: repo.id,
        jobId: "job-too-large-test",
        tempRootDir: await makeTempDir(),
        maxTotalBytes: 50 * 1024 * 1024,
        maxFileCount: 1, // the fixture has 3 files — trips the cap during extraction
        fetchTarball: async () => ({ ok: true, stream: toWebStream(buffer) }),
      }),
    ).rejects.toBeInstanceOf(ArchiveTooLargeError);

    expect(await prisma.repositoryFile.count({ where: { repositoryId: repo.id } })).toBe(0);
  });

  it("a truncated/corrupt tarball stream fails cleanly rather than hanging or crashing the process", async () => {
    const repo = await seedRepository();
    const fullBuffer = await buildTarballGzip(ORDINARY_FIXTURE);
    const truncated = fullBuffer.subarray(0, Math.floor(fullBuffer.length / 3));

    await expect(
      indexRepository({
        installationId: repo.installationId,
        owner: repo.owner,
        repo: repo.name,
        sha: "truncatedsha1",
        repositoryId: repo.id,
        jobId: "job-truncated-test",
        tempRootDir: await makeTempDir(),
        maxTotalBytes: 50 * 1024 * 1024,
        maxFileCount: 10_000,
        fetchTarball: async () => ({ ok: true, stream: toWebStream(truncated) }),
      }),
    ).rejects.toThrow();

    expect(await prisma.repositoryFile.count({ where: { repositoryId: repo.id } })).toBe(0);
  });
});
