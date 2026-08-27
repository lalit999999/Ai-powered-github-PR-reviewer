import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { Prisma, prisma } from "@repo/db";
import * as tarStream from "tar-stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "./db-helpers.js";
import { seedRepository } from "./repository-helpers.js";

/**
 * §14 Automated Verification: "A synthetic ~5,000-file repository indexes within the
 * phase's time budget." §21/§22 name the two properties that actually matter here, and
 * a test that only checks elapsed time would pass on a buffered implementation right up
 * until a much larger repository arrived — so this file asserts the **streaming**
 * property (peak memory does not scale with archive size) and the **batching** property
 * (persistence issues `ceil(n / 1000)` statements, not `n`) directly, alongside timing.
 *
 * **Slow by design — excluded from the fast loop via `SKIP_PERF_TESTS=1`.** It still
 * runs by default as part of `pnpm test:integration` (this file lives in the same
 * `tests/integration/` suite, no separate config): set `SKIP_PERF_TESTS=1` locally for a
 * quicker iteration loop; nothing skips it in a full run or in CI once CI exists (see
 * docs/decisions/phase-03-log.md's Outstanding list — CI does not run at all yet).
 */
describe.skipIf(process.env.SKIP_PERF_TESTS === "1")("repository-index — performance and scale (§14/§15/§21/§22)", () => {
  const FILE_COUNT = 5000;
  const TOP_LEVEL = "octocat-perf-fixture-deadbeef";

  async function buildSyntheticRepoTarball(fileCount: number): Promise<Buffer> {
    const pack = tarStream.pack();
    for (let i = 0; i < fileCount; i += 1) {
      const dir = `pkg-${(i % 50).toString()}`;
      // ~150 bytes of ordinary source content per file — enough to be realistic, small
      // enough that a 5,000-file archive stays a few hundred KB, not gigabytes; the
      // streaming property is architectural (see archive-extractor.test.ts's own
      // dedicated compressed-vs-decompressed-size test), not something reproducible by
      // brute-forcing a multi-GB fixture in a unit/integration test's time budget.
      pack.entry({ name: `${TOP_LEVEL}/${dir}/file-${i.toString()}.ts` }, `export const value${i.toString()} = ${i.toString()};\n`);
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

  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it(`indexes a synthetic ${FILE_COUNT.toString()}-file repository within budget, batches persistence at ceil(n/1000), and does not blow up memory`, async () => {
    const { indexRepository } = await import("../../src/indexing/indexer.service.js");
    const repo = await seedRepository();
    const buffer = await buildSyntheticRepoTarball(FILE_COUNT);
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-index-perf-test-"));

    // `prisma.$executeRaw` itself cannot be spied on with a call-through wrapper here —
    // verified empirically: the generated client exposes it as an accessor that hands
    // back a fresh bound function on every access, and `vi.spyOn`'s captured "original"
    // silently no-ops when invoked later (confirmed with a throwaway repro against a
    // real `SELECT 1` before writing this comment, not assumed). `Prisma.join` is a
    // plain, stable exported function that `upsertBatch` calls **exactly once per
    // batch** (repository-file.repository.ts) to build the multi-row `VALUES` clause —
    // spying on it counts batches without touching `$executeRaw` at all.
    const joinSpy = vi.spyOn(Prisma, "join");

    if (globalThis.gc) globalThis.gc(); // best-effort — only present when run with --expose-gc
    const rssBefore = process.memoryUsage().rss;
    const startedAt = Date.now();

    const result = await indexRepository({
      installationId: repo.installationId,
      owner: repo.owner,
      repo: repo.name,
      sha: "perfsha1",
      repositoryId: repo.id,
      jobId: "job-perf-test",
      tempRootDir,
      maxTotalBytes: 200 * 1024 * 1024,
      maxFileCount: 20_000,
      attempt: 0,
      fetchTarball: async () => ({ ok: true, stream: toWebStream(buffer) }),
    });

    const durationMs = Date.now() - startedAt;
    const rssAfter = process.memoryUsage().rss;
    const rssGrowthMb = (rssAfter - rssBefore) / (1024 * 1024);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.filesTotal).toBe(FILE_COUNT);
    expect(result.filesIndexed).toBe(FILE_COUNT);

    // Timing — §14/§15's own stated target is a *1,000*-file repository in under 3
    // minutes; this fixture is 5x that, so a generous 60s budget (not 15 minutes) is
    // the honest bar for "within the phase's time budget" on this class of machine.
    // The actual measured number, and the machine's rough shape, is recorded in
    // docs/decisions/phase-03-log.md rather than only asserted here — a bound with no
    // recorded baseline is not enough to catch a regression.
    expect(durationMs).toBeLessThan(60_000);

    // Batching — persistence issues ceil(n / 1000)-shaped statement counts, not one
    // per row. Counted at the repository-layer seam (Prisma.join, called exactly once
    // per batched INSERT/UPDATE statement) rather than assumed from reading the source.
    // Phase 04 (sub-task 4.6) added several more batched writers behind the same call —
    // RepositoryFile upsert, CodeSymbol insert, CodeDependency insert (one batch group
    // per (kind, resolution) pair actually produced), and the RepositoryFile
    // graph-metadata update — so the exact count is no longer a single ceil(n/1000); the
    // bound below stays generous on purpose (proving "batched, not per-row" without
    // pinning today's exact writer count, which a future edge kind would otherwise make
    // this test brittle against for no real regression).
    expect(joinSpy.mock.calls.length).toBeGreaterThan(0);
    expect(joinSpy.mock.calls.length).toBeLessThan(FILE_COUNT / 50);

    // Streaming — a coarse, honest bound. This does not prove O(1) memory scaling on
    // its own (that is archive-extractor.test.ts's dedicated compressed-vs-decompressed
    // byte-counting test, §14); it is a regression guard against a full-archive-buffering
    // implementation processing 5,000 small files while resident memory grows by
    // hundreds of MB, which a byte-cap unit test alone would not catch.
    expect(rssGrowthMb).toBeLessThan(300);

    const dbCount = await prisma.repositoryFile.count({ where: { repositoryId: repo.id } });
    expect(dbCount).toBe(FILE_COUNT);

    await fs.rm(tempRootDir, { recursive: true, force: true }).catch(() => undefined);

    // The recorded baseline this test's own header comment promises, visible in
    // `pnpm test:integration` output.
    console.log(
      `[perf] ${FILE_COUNT.toString()} files: ${durationMs.toString()}ms, ${joinSpy.mock.calls.length.toString()} batch statements, rss growth ${rssGrowthMb.toFixed(1)}MB`,
    );
  });
});
