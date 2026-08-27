import { gzipSync } from "node:zlib";
import { InngestTestEngine } from "@inngest/test";
import { prisma } from "@repo/db";
import { REPOSITORY_INDEX_REQUESTED } from "@repo/shared";
import * as tarStream from "tar-stream";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
  fetchTarballStream: (...args: unknown[]) =>
    fetchTarballStream(...(args as [])),
}));

const { repositoryGithub } = await import("@repo/github");
const { repositoryIndex } =
  await import("../../src/inngest/functions/repository-index.js");
const { indexRepository } =
  await import("../../src/indexing/indexer.service.js");
const { ArchiveTooLargeError } =
  await import("../../src/indexing/fetcher/archive-extractor.js");
const repositoryRepository =
  await import("../../src/indexing/persistence/repository.repository.js");
const indexJobRepository =
  await import("../../src/indexing/persistence/index-job.repository.js");

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

/**
 * Sub-task 4.7's own Definition of Done: a synthetic fixture covering every edge/symbol
 * shape the phase document names — an exported function, an importer that calls it, a
 * test file, a class extension, an external import, an unresolvable import, a malformed
 * file, and a circular import pair — driven through the **real** Inngest function against
 * **real** Postgres, exactly like `ORDINARY_FIXTURE`'s own describe block above.
 *
 * Function names deliberately avoid tree-sitter's own `^use[A-Z0-9]` HOOK heuristic
 * (`typescript.adapter.ts`'s `HOOK_NAME_PATTERN`) — a name like `useHelper` would be
 * captured as `kind: "HOOK"`, not `"FUNCTION"`, which is irrelevant to what this fixture
 * is testing and would just be a confusing surprise in the symbol-kind assertions below.
 *
 * The exact `src/broken.ts` content is the same one `graph-builder.test.ts` already
 * verified crosses the 10% error-node tolerance ratio (docs/decisions/phase-04-log.md,
 * Prompt 2 §5) — reused rather than re-derived.
 */
const KNOWLEDGE_GRAPH_FIXTURE: FixtureEntry[] = [
  file("package.json", '{"name":"fixture"}\n'),
  file("src/util.ts", "export function helper(): number {\n  return 1;\n}\n"),
  file(
    "src/caller.ts",
    'import { helper } from "./util.js";\n\nexport function callHelper(): number {\n  return helper();\n}\n',
  ),
  file(
    "src/base.ts",
    'export class Base {\n  greet(): string {\n    return "hi";\n  }\n}\n',
  ),
  file(
    "src/derived.ts",
    'import { Base } from "./base.js";\n\nexport class Derived extends Base {}\n',
  ),
  file(
    "src/external-consumer.ts",
    'import { z } from "zod";\n\nexport function wrapZod() {\n  return z;\n}\n',
  ),
  file(
    "src/unresolved-consumer.ts",
    'import { thing } from "./does-not-exist.js";\n\nexport function readThing() {\n  return thing;\n}\n',
  ),
  file(
    "src/caller.test.ts",
    'import { callHelper } from "./caller.js";\n\nexport function runTest() {\n  return callHelper();\n}\n',
  ),
  file(
    "src/broken.ts",
    "// deliberately broken (§14)\nexport function calculateTotal(items {\n  return items",
  ),
  file(
    "src/circular-a.ts",
    'import { getB } from "./circular-b.js";\n\nexport function getA(): number {\n  return 1;\n}\n\nexport function readB(): number {\n  return getB();\n}\n',
  ),
  file(
    "src/circular-b.ts",
    'import { getA } from "./circular-a.js";\n\nexport function getB(): number {\n  return 2;\n}\n\nexport function readA(): number {\n  return getA();\n}\n',
  ),
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
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ids: ["evt_test"], status: 200 }), {
          status: 200,
        }),
    ),
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
  vi.mocked(repositoryGithub.getHeadCommit).mockResolvedValue({
    ok: true,
    commit: { sha },
  });
}

function mockTarball(buffer: Buffer) {
  fetchTarballStream.mockResolvedValue({
    ok: true,
    stream: toWebStream(buffer),
  });
}

/** `t.execute()`'s `error` field is whatever the function actually threw, round-tripped
 * through Inngest's own `JsonError` serialization (`{ name, message, stack, cause? }` —
 * a plain object, not a live `Error` instance, by the time it reaches this test) — the
 * same round trip `repository-index.ts`'s own header comment documents for `onFailure`.
 * Narrowed here rather than asserted `as Error` at every call site. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message;
  return String(error);
}

function buildEvent(
  repo: SeededRepository,
  overrides: Partial<{ indexJobId: string }> = {},
) {
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

    const t = new InngestTestEngine({
      function: repositoryIndex,
      events: [buildEvent(repo)],
    });
    const { result, error } = await t.execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      skipped: false,
      commitSha: "deadbeef1234567",
      filesTotal: 3,
      filesIndexed: 3,
    });

    const finalRepo = await prisma.repository.findUnique({
      where: { id: repo.id },
    });
    expect(finalRepo?.indexStatus).toBe("INDEXED");
    expect(finalRepo?.indexedCommitSha).toBe("deadbeef1234567");
    expect(finalRepo?.indexedFileCount).toBe(3);

    const finalJob = await prisma.indexJob.findFirst({
      where: { repositoryId: repo.id },
    });
    expect(finalJob).not.toBeNull();
    expect(finalJob?.status).toBe("SUCCEEDED");
    expect(finalJob?.progressPercent).toBe(100);
    expect(finalJob!.filesProcessed + finalJob!.filesSkipped).toBe(
      finalJob!.filesTotal,
    );
    // Exactly one IndexJob row for this run — no lock double-acquisition, no orphan row.
    expect(
      await prisma.indexJob.count({ where: { repositoryId: repo.id } }),
    ).toBe(1);

    const files = await prisma.repositoryFile.findMany({
      where: { repositoryId: repo.id },
      orderBy: { path: "asc" },
    });
    // Repository-relative paths — the tarball's TOP_LEVEL/ component is stripped.
    expect(files.map((f) => f.path)).toEqual([
      "package.json",
      "src/index.ts",
      "src/utils.ts",
    ]);
    expect(files.every((f) => f.commitSha === "deadbeef1234567")).toBe(true);
    expect(files.every((f) => f.indexState === "INDEXED")).toBe(true);

    // §9/§14/§15: exactly two GitHub API calls per full index run.
    expect(repositoryGithub.getHeadCommit).toHaveBeenCalledTimes(1);
    expect(fetchTarballStream).toHaveBeenCalledTimes(1);
  });

  it("re-indexing at the same, already-indexed SHA is a no-op that still marks the job SUCCEEDED and touches no files", async () => {
    const repo = await seedRepository({
      indexStatus: "INDEXED",
      indexedCommitSha: "samecommit1",
    });
    mockHeadCommit("samecommit1");

    const t = new InngestTestEngine({
      function: repositoryIndex,
      events: [buildEvent(repo)],
    });
    const { result, error } = await t.execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      skipped: true,
      reason: "ALREADY_INDEXED",
      commitSha: "samecommit1",
    });

    expect(fetchTarballStream).not.toHaveBeenCalled();
    expect(
      await prisma.repositoryFile.count({ where: { repositoryId: repo.id } }),
    ).toBe(0);

    const job = await prisma.indexJob.findFirst({
      where: { repositoryId: repo.id },
    });
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
        attempt: 0,
        fetchTarball: async () => ({ ok: true, stream: toWebStream(buffer) }),
      });

    const first = await runOnce();
    expect(first.ok).toBe(true);
    const afterFirst = await prisma.repositoryFile.findMany({
      where: { repositoryId: repo.id },
    });
    expect(afterFirst).toHaveLength(3);

    // The "restart": the same step body runs again from scratch against the identical
    // target, exactly what a real Inngest retry of a not-yet-memoized step does.
    const second = await runOnce();
    expect(second.ok).toBe(true);
    const afterSecond = await prisma.repositoryFile.findMany({
      where: { repositoryId: repo.id },
    });
    expect(afterSecond).toHaveLength(3); // still 3, not 6 — the (repositoryId, path) upsert held.
    expect(new Set(afterSecond.map((f) => f.id))).toEqual(
      new Set(afterFirst.map((f) => f.id)),
    ); // same rows, updated in place
  });

  it("a run that never reaches its terminal step leaves Repository at INDEXING, never a silent INDEXED", async () => {
    const repo = await seedRepository();
    mockHeadCommit("interruptedsha1");
    mockTarball(await buildTarballGzip(ORDINARY_FIXTURE));

    const t = new InngestTestEngine({
      function: repositoryIndex,
      events: [buildEvent(repo)],
    });
    // Stop right after fetch-extract-persist has run (files are on disk and persisted)
    // but before the terminal "mark-repository-indexed"/"mark-job-succeeded" steps —
    // simulating the worker being killed in that exact window.
    await t.executeStep("fetch-extract-persist");

    const repoRow = await prisma.repository.findUnique({
      where: { id: repo.id },
    });
    expect(repoRow?.indexStatus).toBe("INDEXING"); // never silently INDEXED
    expect(repoRow?.indexedCommitSha).toBeNull();

    const job = await prisma.indexJob.findFirst({
      where: { repositoryId: repo.id },
    });
    expect(job?.status).toBe("RUNNING"); // never silently SUCCEEDED with an incomplete file set
  });
});

describe("repository-index — §12's failure modes, coded correctly and persisted correctly", () => {
  it("REPO_NOT_FOUND: a missing default branch throws the coded error, and the equivalent terminal write lands correctly in Postgres", async () => {
    const repo = await seedRepository();
    vi.mocked(repositoryGithub.getHeadCommit).mockResolvedValue({
      ok: false,
      reason: "NOT_ACCESSIBLE",
    });

    const t = new InngestTestEngine({
      function: repositoryIndex,
      events: [buildEvent(repo)],
    });
    const { error } = await t.execute();

    expect(error).toBeDefined();
    expect(errorMessage(error)).toMatch(/^REPO_NOT_FOUND:/);

    // @inngest/test does not invoke onFailure automatically (documented limitation,
    // see this file's header) — exercise the exact terminal-write functions onFailure
    // calls, directly, against the same real Postgres.
    await repositoryRepository.markFailed({
      repositoryId: repo.id,
      code: "REPO_NOT_FOUND",
      message: "not found",
    });
    const job = await prisma.indexJob.findFirst({
      where: { repositoryId: repo.id },
    });
    await indexJobRepository.markFailed(job!.id, {
      code: "REPO_NOT_FOUND",
      message: "not found",
    });

    const finalRepo = await prisma.repository.findUnique({
      where: { id: repo.id },
    });
    expect(finalRepo?.indexStatus).toBe("FAILED");
    expect(finalRepo?.indexError).toMatchObject({ code: "REPO_NOT_FOUND" });

    const finalJob = await prisma.indexJob.findFirst({
      where: { repositoryId: repo.id },
    });
    expect(finalJob?.status).toBe("FAILED");
    expect(finalJob?.error).toMatchObject({ code: "REPO_NOT_FOUND" });
  });

  it("UNSAFE_ARCHIVE: a path-traversal tarball fails the whole job with a generic message, and no attack detail leaks into it", async () => {
    const repo = await seedRepository();
    mockHeadCommit("unsafesha1");
    const maliciousBuffer = await buildTarballGzip([
      {
        header: { name: `${TOP_LEVEL}/`, type: "directory" },
        content: undefined,
      },
      {
        header: { name: `${TOP_LEVEL}/../../etc/passwd`, type: "file" },
        content: "hacked",
      },
    ]);
    mockTarball(maliciousBuffer);

    const t = new InngestTestEngine({
      function: repositoryIndex,
      events: [buildEvent(repo)],
    });
    const { error } = await t.execute();

    expect(error).toBeDefined();
    const message = errorMessage(error);
    expect(message).toMatch(/^UNSAFE_ARCHIVE:/);
    // §12: "do not surface attack details to the UI" — the message itself must stay
    // generic, since it is exactly what a downstream onFailure write persists verbatim.
    expect(message).not.toMatch(/passwd|etc\/|\.\.\//);

    expect(
      await prisma.repositoryFile.count({ where: { repositoryId: repo.id } }),
    ).toBe(0);
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
        attempt: 0,
        fetchTarball: async () => ({ ok: true, stream: toWebStream(buffer) }),
      }),
    ).rejects.toBeInstanceOf(ArchiveTooLargeError);

    expect(
      await prisma.repositoryFile.count({ where: { repositoryId: repo.id } }),
    ).toBe(0);
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
        attempt: 0,
        fetchTarball: async () => ({
          ok: true,
          stream: toWebStream(truncated),
        }),
      }),
    ).rejects.toThrow();

    expect(
      await prisma.repositoryFile.count({ where: { repositoryId: repo.id } }),
    ).toBe(0);
  });
});

describe("repository-index — knowledge graph, driven through the real Inngest function (Phase 04, sub-task 4.7)", () => {
  it("parses every file, resolves every edge/symbol kind the fixture exercises, survives a malformed file, and marks the run INDEXED/SUCCEEDED", async () => {
    const repo = await seedRepository();
    mockHeadCommit("graphsha1");
    mockTarball(await buildTarballGzip(KNOWLEDGE_GRAPH_FIXTURE));

    const t = new InngestTestEngine({
      function: repositoryIndex,
      events: [buildEvent(repo)],
    });
    const { result, error } = await t.execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ skipped: false, commitSha: "graphsha1" });

    const finalRepo = await prisma.repository.findUnique({
      where: { id: repo.id },
    });
    // §4/§15: a single malformed file (src/broken.ts) never fails the overall job.
    expect(finalRepo?.indexStatus).toBe("INDEXED");

    const finalJob = await prisma.indexJob.findFirst({
      where: { repositoryId: repo.id },
    });
    expect(finalJob?.status).toBe("SUCCEEDED");
    expect(finalJob?.symbolsCreated).toBe(12);
    expect(finalJob?.edgesCreated).toBe(36);

    const symbols = await prisma.codeSymbol.findMany({
      where: { repositoryId: repo.id },
    });
    expect(symbols).toHaveLength(12);
    expect(symbols.map((s) => s.name).sort()).toEqual(
      [
        "Base",
        "Derived",
        "callHelper",
        "getA",
        "getB",
        "greet",
        "helper",
        "readA",
        "readB",
        "readThing",
        "runTest",
        "wrapZod",
      ].sort(),
    );
    // src/broken.ts's own symbol never made it in — the malformed file contributed nothing.
    expect(symbols.some((s) => s.name === "calculateTotal")).toBe(false);

    const edges = await prisma.codeDependency.findMany({
      where: { repositoryId: repo.id },
    });
    const byKind = (kind: string) => edges.filter((e) => e.kind === kind);

    // CALLS: callHelper -> helper, runTest -> callHelper, readB -> getB, readA -> getA
    // (the last two crossing the circular-a.ts <-> circular-b.ts import pair).
    expect(byKind("CALLS")).toHaveLength(4);
    // EXTENDS: Derived -> Base.
    expect(byKind("EXTENDS")).toHaveLength(1);
    // TESTS: caller.test.ts -> caller.ts (its own import target, not a test file).
    expect(byKind("TESTS")).toHaveLength(1);
    // CONTAINS/EXPORTS: one per symbol / one per locally-declared exported symbol
    // (`greet` is a class method, not independently exported, so EXPORTS is 12 - 1).
    expect(byKind("CONTAINS")).toHaveLength(12);
    expect(byKind("EXPORTS")).toHaveLength(11);

    const imports = byKind("IMPORTS");
    expect(imports).toHaveLength(7);
    expect(imports.filter((e) => e.resolution === "RESOLVED")).toHaveLength(5);
    expect(
      imports.some(
        (e) => e.resolution === "EXTERNAL" && e.externalPackage === "zod",
      ),
    ).toBe(true);
    expect(
      imports.some(
        (e) =>
          e.resolution === "UNRESOLVED" &&
          e.rawSpecifier === "./does-not-exist.js",
      ),
    ).toBe(true);

    const files = await prisma.repositoryFile.findMany({
      where: { repositoryId: repo.id },
    });
    expect(files).toHaveLength(11); // 10 source files + package.json
    const byPath = new Map(files.map((f) => [f.path, f]));

    const broken = byPath.get("src/broken.ts");
    expect(broken?.indexState).toBe("INDEXED"); // still text-indexed (§4: never dropped)
    expect(broken?.parseState).toBe("FAILED");
    expect(broken?.symbolCount).toBe(0);

    // A well-connected file (imported from and called into) scores a materially higher
    // inboundEdgeCount than a leaf file nothing imports or calls.
    expect(byPath.get("src/util.ts")!.inboundEdgeCount).toBeGreaterThan(
      byPath.get("src/external-consumer.ts")!.inboundEdgeCount,
    );

    expect(byPath.get("src/caller.test.ts")?.isTest).toBe(true);
    expect(byPath.get("src/derived.ts")?.isTest).toBe(false);

    // The circular import pair: both directions resolve, and both files still get their
    // own symbols/edges rather than one starving the other.
    expect(byPath.get("src/circular-a.ts")?.parseState).toBe("OK");
    expect(byPath.get("src/circular-b.ts")?.parseState).toBe("OK");
    expect(byPath.get("src/circular-a.ts")?.symbolCount).toBe(2);
    expect(byPath.get("src/circular-b.ts")?.symbolCount).toBe(2);
  });
});

describe("repository-index — the knowledge graph is idempotent across a full re-run (Phase 04, sub-task 4.7)", () => {
  it("running the whole index twice at the same commit produces identical symbol/edge counts, with no duplicate edges", async () => {
    const repo = await seedRepository();
    const buffer = await buildTarballGzip(KNOWLEDGE_GRAPH_FIXTURE);

    const runOnce = async () =>
      indexRepository({
        installationId: repo.installationId,
        owner: repo.owner,
        repo: repo.name,
        sha: "graphrerunsha1",
        repositoryId: repo.id,
        jobId: "job-graph-rerun-test",
        tempRootDir: await makeTempDir(),
        maxTotalBytes: 50 * 1024 * 1024,
        maxFileCount: 10_000,
        attempt: 0,
        fetchTarball: async () => ({ ok: true, stream: toWebStream(buffer) }),
      });

    const first = await runOnce();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected ok result");

    const symbolsAfterFirst = await prisma.codeSymbol.findMany({
      where: { repositoryId: repo.id },
    });
    const edgesAfterFirst = await prisma.codeDependency.findMany({
      where: { repositoryId: repo.id },
    });

    // The "restart": the same unit runs again from scratch against the identical target —
    // exactly what a real Inngest retry of a not-yet-memoized step does (matching the
    // RepositoryFile-only version of this test above).
    const second = await runOnce();
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected ok result");

    const symbolsAfterSecond = await prisma.codeSymbol.findMany({
      where: { repositoryId: repo.id },
    });
    const edgesAfterSecond = await prisma.codeDependency.findMany({
      where: { repositoryId: repo.id },
    });

    expect(second.symbolsCreated).toBe(first.symbolsCreated);
    expect(second.edgesCreated).toBe(first.edgesCreated);
    expect(symbolsAfterSecond).toHaveLength(symbolsAfterFirst.length);
    expect(edgesAfterSecond).toHaveLength(edgesAfterFirst.length);

    // Full-replace, not append: the edge-identity tuple never repeats within the surviving
    // set (no duplicate edges), and the row counts read straight from Postgres agree with
    // what the second run itself reported creating.
    const edgeIdentity = (e: (typeof edgesAfterSecond)[number]) =>
      `${e.kind}:${e.fromFileId ?? ""}:${e.toFileId ?? ""}:${e.fromSymbolId ?? ""}:${e.toSymbolId ?? ""}`;
    expect(new Set(edgesAfterSecond.map(edgeIdentity)).size).toBe(
      edgesAfterSecond.length,
    );
    expect(
      await prisma.codeSymbol.count({ where: { repositoryId: repo.id } }),
    ).toBe(symbolsAfterFirst.length);
    expect(
      await prisma.codeDependency.count({ where: { repositoryId: repo.id } }),
    ).toBe(edgesAfterFirst.length);
  });
});
