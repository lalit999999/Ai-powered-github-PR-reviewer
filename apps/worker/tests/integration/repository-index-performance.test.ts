import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { Prisma, prisma } from "@repo/db";
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
 *
 * Prompt 5, sub-task 5.3(a): extends the file above rather than forking it, per that
 * sub-task's own instruction. `ORDINARY_FIXTURE` (below) generates `export const value =
 * i` content that produces almost no `CodeSymbol`/`CodeDependency` rows at all
 * (`SymbolKind.VARIABLE` is a known, documented gap — see docs/decisions/phase-04-log.md,
 * Prompt 2 §8) — real enough to prove the file-inventory pipeline stays fast at scale, but
 * not the parse/resolve pipeline this phase actually added. `buildRealisticRepoTarball`
 * below is the phase-04-specific addition: every generated file has real imports, several
 * functions, and calls between them, so the 10,000-file test actually exercises
 * tree-sitter parsing and the full graph-builder — the number phase-04 §15's acceptance
 * criterion cares about is parse+resolve throughput, not just file-inventory throughput.
 */
describe.skipIf(process.env.SKIP_PERF_TESTS === "1")(
  "repository-index — performance and scale (§14/§15/§21/§22)",
  () => {
    const FILE_COUNT = 5000;
    const TOP_LEVEL = "octocat-perf-fixture-deadbeef";

    async function buildSyntheticRepoTarball(
      fileCount: number,
    ): Promise<Buffer> {
      const pack = tarStream.pack();
      for (let i = 0; i < fileCount; i += 1) {
        const dir = `pkg-${(i % 50).toString()}`;
        // ~150 bytes of ordinary source content per file — enough to be realistic, small
        // enough that a 5,000-file archive stays a few hundred KB, not gigabytes; the
        // streaming property is architectural (see archive-extractor.test.ts's own
        // dedicated compressed-vs-decompressed-size test), not something reproducible by
        // brute-forcing a multi-GB fixture in a unit/integration test's time budget.
        pack.entry(
          { name: `${TOP_LEVEL}/${dir}/file-${i.toString()}.ts` },
          `export const value${i.toString()} = ${i.toString()};\n`,
        );
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
      const { indexRepository } =
        await import("../../src/indexing/indexer.service.js");
      const repo = await seedRepository();
      const buffer = await buildSyntheticRepoTarball(FILE_COUNT);
      const tempRootDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "repo-index-perf-test-"),
      );

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

      const dbCount = await prisma.repositoryFile.count({
        where: { repositoryId: repo.id },
      });
      expect(dbCount).toBe(FILE_COUNT);

      await fs
        .rm(tempRootDir, { recursive: true, force: true })
        .catch(() => undefined);

      // The recorded baseline this test's own header comment promises, visible in
      // `pnpm test:integration` output.
      console.log(
        `[perf] ${FILE_COUNT.toString()} files: ${durationMs.toString()}ms, ${joinSpy.mock.calls.length.toString()} batch statements, rss growth ${rssGrowthMb.toFixed(1)}MB`,
      );
    });
  },
);

/**
 * Prompt 5, sub-task 5.3(a): phase-04 §15's own acceptance criterion — "a 10,000-file
 * repository completes parsing in under 5 minutes" — measured against **realistically
 * shaped** source, not `export const x = 1`. Every generated file has a relative import to
 * its predecessor in the same directory, two exported functions, and a real call between
 * them, so tree-sitter, the import resolver, and the call resolver all do genuine work
 * across all 10,000 files — not just the file-inventory pipeline `ORDINARY_FIXTURE`/
 * `KNOWLEDGE_GRAPH_FIXTURE`-style content exercises above.
 *
 * Separate `describe` block, same `SKIP_PERF_TESTS=1` opt-out as the suite above — this is
 * the slower of the two by a wide margin (10,000 real parses + a full pass-2 resolution,
 * not 5,000 near-empty files), so it is kept as its own `it`, not folded into the block
 * above, to keep each test's own timing signal legible.
 */
describe.skipIf(process.env.SKIP_PERF_TESTS === "1")(
  "repository-index — 10,000-file parse budget, realistic content (phase-04 §15)",
  () => {
    const REALISTIC_FILE_COUNT = 10_000;
    const FILES_PER_DIR = 100;
    const TOP_LEVEL = "octocat-10k-fixture-deadbeef";

    /**
     * File 0 in each directory is self-contained; files 1..N-1 import the previous file's
     * `helper` and call it from their own `helper`, alongside a same-file call to a second,
     * local function — two `CALLS` edges and one `IMPORTS` edge per file (bar the first in
     * each directory), plus two `CodeSymbol` rows. ~150–200 bytes of real TypeScript per
     * file, not padding — small enough that 10,000 files stays a reasonably sized archive,
     * large enough that every construct this phase extracts is genuinely exercised.
     */
    function generateFileContent(dir: string, indexInDir: number): string {
      const local = `function local${indexInDir.toString()}(x: number): number {\n  return x * 2;\n}\n\n`;
      if (indexInDir === 0) {
        return `${local}export function helper0(x: number): number {\n  return local0(x) + 1;\n}\n`;
      }
      const prevImport = `import { helper${(indexInDir - 1).toString()} } from "./file-${(indexInDir - 1).toString()}.js";\n\n`;
      return (
        `${prevImport}${local}export function helper${indexInDir.toString()}(x: number): number {\n` +
        `  return local${indexInDir.toString()}(x) + helper${(indexInDir - 1).toString()}(x);\n}\n`
      );
    }

    async function buildRealisticRepoTarball(
      fileCount: number,
    ): Promise<Buffer> {
      const pack = tarStream.pack();
      pack.entry(
        { name: `${TOP_LEVEL}/package.json` },
        '{"name":"perf-10k-fixture"}\n',
      );
      const dirCount = Math.ceil(fileCount / FILES_PER_DIR);
      let written = 0;
      for (let d = 0; d < dirCount && written < fileCount; d += 1) {
        const dir = `pkg-${d.toString()}`;
        for (
          let i = 0;
          i < FILES_PER_DIR && written < fileCount;
          i += 1, written += 1
        ) {
          pack.entry(
            { name: `${TOP_LEVEL}/${dir}/file-${i.toString()}.ts` },
            generateFileContent(dir, i),
          );
        }
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

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it(
      `parses and resolves a realistic ${REALISTIC_FILE_COUNT.toString()}-file repository within 5 minutes, reporting throughput and peak RSS`,
      async () => {
        const { indexRepository } =
          await import("../../src/indexing/indexer.service.js");
        const repo = await seedRepository();
        const buffer = await buildRealisticRepoTarball(REALISTIC_FILE_COUNT);
        const tempRootDir = await fs.mkdtemp(
          path.join(os.tmpdir(), "repo-index-10k-perf-test-"),
        );

        if (globalThis.gc) globalThis.gc();
        const rssBefore = process.memoryUsage().rss;
        let peakRss = rssBefore;
        const rssPoll = setInterval(() => {
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
        }, 250);

        const startedAt = Date.now();
        const result = await indexRepository({
          installationId: repo.installationId,
          owner: repo.owner,
          repo: repo.name,
          sha: "perf10ksha1",
          repositoryId: repo.id,
          jobId: "job-10k-perf-test",
          tempRootDir,
          maxTotalBytes: 200 * 1024 * 1024,
          maxFileCount: 20_000,
          attempt: 0,
          fetchTarball: async () => ({ ok: true, stream: toWebStream(buffer) }),
        });
        const durationMs = Date.now() - startedAt;
        clearInterval(rssPoll);
        peakRss = Math.max(peakRss, process.memoryUsage().rss);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("expected ok result");
        // +1 for the fixture's own package.json (NOT_PARSED, but still a real indexed file).
        expect(result.filesIndexed).toBe(REALISTIC_FILE_COUNT + 1);
        expect(result.parseFailureCount).toBe(0);
        // Every file but the first in each of the 100 directories produces exactly one
        // resolved CALLS edge to its predecessor's helper, plus one same-file call to its own
        // local() — both should resolve cleanly (relative imports, same-file calls are the
        // easiest resolution rules), so the unresolved ratio on this synthetic, well-formed
        // repository should be exactly zero.
        expect(result.unresolvedImportRatio).toBe(0);

        // phase-04 §15's own bound: under 5 minutes.
        expect(durationMs).toBeLessThan(5 * 60 * 1000);

        const filesPerSecond = REALISTIC_FILE_COUNT / (durationMs / 1000);
        const symbolsPerSecond = result.symbolsCreated / (durationMs / 1000);
        const peakRssMb = peakRss / (1024 * 1024);

        const dbFileCount = await prisma.repositoryFile.count({
          where: { repositoryId: repo.id },
        });
        expect(dbFileCount).toBe(REALISTIC_FILE_COUNT + 1);
        const dbSymbolCount = await prisma.codeSymbol.count({
          where: { repositoryId: repo.id },
        });
        // Two functions (helperN, localN) per file, every file.
        expect(dbSymbolCount).toBe(REALISTIC_FILE_COUNT * 2);

        await fs
          .rm(tempRootDir, { recursive: true, force: true })
          .catch(() => undefined);

        // The recorded baseline this sub-task's own report pastes verbatim — files/s and
        // symbols/s make a future regression legible independent of the machine that measured
        // it; the machine itself is recorded in the report alongside this line's output.
        console.log(
          `[perf-10k] ${REALISTIC_FILE_COUNT.toString()} files: ${durationMs.toString()}ms total ` +
            `(${filesPerSecond.toFixed(1)} files/s, ${symbolsPerSecond.toFixed(1)} symbols/s), ` +
            `symbolsCreated=${result.symbolsCreated.toString()}, edgesCreated=${result.edgesCreated.toString()}, ` +
            `peak RSS ${peakRssMb.toFixed(1)}MB`,
        );
      },
      5 * 60 * 1000 + 30_000,
    );
  },
);
