import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@repo/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildKnowledgeGraph } from "../../src/indexing/graph/graph-builder.js";
import { buildRepoContext } from "../../src/indexing/graph/repo-context.js";
import {
  findRepositoryFilesByCommit,
  upsertRepositoryFiles,
} from "../../src/indexing/persistence/repository-file.repository.js";
import { walkTree } from "../../src/indexing/walk-tree.js";
import { resetDatabase } from "./db-helpers.js";
import { seedRepository } from "./repository-helpers.js";

/**
 * Prompt 5, sub-task 5.3(b): phase-04 §14/§15's "unresolved-import ratio is under 15% on a
 * well-formed TS repository", measured against a **genuinely real** repository — this
 * monorepo itself (`plan.md`'s own suggestion: "a legitimate and convenient subject"),
 * not another fixture written to make the resolver look good. It was not written by
 * anyone tuning the resolver's ambiguity rules, and it exercises real `tsconfig.json`
 * `paths`, real pnpm workspaces, and real external-package imports at a scale (hundreds of
 * files) the hand-built `graph-repo` fixture does not attempt.
 *
 * Runs the same walk -> persist -> repo-context -> graph-build sequence
 * `graph-repo-fixture-helpers.ts` uses, pointed at the repository's own root directory
 * instead of the committed fixture — there is no tarball step at all, since the source is
 * already on disk exactly where a real extracted repository would be.
 */

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL("../../../../", import.meta.url)),
);
const COMMIT_SHA = "self-index-sha1";

beforeEach(resetDatabase);
afterAll(async () => {
  await prisma.$disconnect();
});

describe("unresolved-import ratio — indexing this monorepo itself (phase-04 §14/§15)", () => {
  it("stays under 15%, and prints the top unresolved specifiers if it does not", async () => {
    const repository = await seedRepository();

    const walkedFull = await walkTree(REPO_ROOT);
    // Excludes this phase's own test fixtures (tests/fixtures/**) — those were written by
    // the same person tuning this resolver, deliberately contain unresolvable imports and
    // ambiguity, and including them here would bias exactly the number this test exists
    // to measure honestly. Every other real source file in the monorepo is included.
    const walked = {
      ...walkedFull,
      files: walkedFull.files.filter(
        (f) => !f.path.includes("tests/fixtures/"),
      ),
    };
    // Sanity check on the fixture's own size claim above — if this repository's shape
    // changes enough to fall far outside "hundreds of files", the comment above (and the
    // reasoning for using it as "a real repository") should be revisited.
    expect(walked.files.length).toBeGreaterThan(100);

    await upsertRepositoryFiles(
      walked.files.map((file) => ({
        repositoryId: repository.id,
        path: file.path,
        commitSha: COMMIT_SHA,
        language: file.language,
        contentHash: file.contentHash,
        sizeBytes: file.sizeBytes,
        lineCount: file.lineCount,
        packageName: file.packageName,
        classification: file.classification,
        indexState: file.indexState,
        skipReason: file.skipReason,
        isTest: file.isTest,
        isGenerated: file.isGenerated,
      })),
    );

    const persistedFiles = await findRepositoryFilesByCommit(
      repository.id,
      COMMIT_SHA,
    );
    const repoContext = await buildRepoContext(
      REPO_ROOT,
      walked.files.map((f) => f.path),
    );

    const graph = await buildKnowledgeGraph({
      rootDir: REPO_ROOT,
      files: persistedFiles,
      repoContext,
      repositoryId: repository.id,
      commitSha: COMMIT_SHA,
      attempt: 0,
    });

    // The exact aggregate query sub-task 5.3(b) specifies.
    const [totals] = await prisma.$queryRaw<
      {
        total: bigint;
        resolved: bigint;
        external: bigint;
        unresolved: bigint;
        ratio: number | null;
      }[]
    >`
      SELECT
        COUNT(*)                                                        AS total,
        COUNT(*) FILTER (WHERE resolution = 'RESOLVED')                 AS resolved,
        COUNT(*) FILTER (WHERE resolution = 'EXTERNAL')                 AS external,
        COUNT(*) FILTER (WHERE resolution = 'UNRESOLVED')               AS unresolved,
        ROUND(COUNT(*) FILTER (WHERE resolution = 'UNRESOLVED')::numeric
              / NULLIF(COUNT(*),0), 4)                                  AS ratio
      FROM "CodeDependency"
      WHERE "repositoryId" = ${repository.id} AND kind = 'IMPORTS'
    `;

    const total = Number(totals?.total ?? 0n);
    const resolved = Number(totals?.resolved ?? 0n);
    const external = Number(totals?.external ?? 0n);
    const unresolved = Number(totals?.unresolved ?? 0n);
    const ratio = total === 0 ? 0 : unresolved / total;

    console.log(
      `\n=== Unresolved-import ratio on this monorepo (${walked.files.length.toString()} files, ${graph.symbolsCreated.toString()} symbols): ` +
        `${(ratio * 100).toFixed(2)}% (${unresolved.toString()}/${total.toString()} imports; resolved=${resolved.toString()}, external=${external.toString()}) ===\n`,
    );

    if (unresolved > 0) {
      const topUnresolved = await prisma.$queryRaw<
        { rawSpecifier: string | null; count: bigint }[]
      >`
        SELECT "rawSpecifier", COUNT(*) AS count FROM "CodeDependency"
        WHERE "repositoryId" = ${repository.id} AND resolution = 'UNRESOLVED'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 20
      `;
      console.log("Top unresolved specifiers:");
      for (const row of topUnresolved) {
        console.log(
          `  ${row.count.toString()}x  ${row.rawSpecifier ?? "(none)"}`,
        );
      }
    }

    expect(ratio).toBeLessThan(0.15);
  }, 300_000); // a real filesystem walk + full parse of this monorepo — ~7s measured in
  // isolation, but apps/api's own Testcontainers-backed test:integration run runs
  // concurrently with this one (turbo does not serialize across packages by default),
  // and two simultaneous Testcontainers Postgres instances plus this test's own
  // real tree-sitter parsing of 500+ files is measurably slower under that contention.
  // A generous budget here is the honest fix — this test's own correctness does not
  // depend on wall-clock speed the way the dedicated perf suite's does.
});
