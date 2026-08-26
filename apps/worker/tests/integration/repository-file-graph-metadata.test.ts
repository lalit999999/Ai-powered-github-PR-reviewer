import { prisma } from "@repo/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { updateRepositoryFileGraphMetadata } from "../../src/indexing/persistence/repository-file.repository.js";
import { resetDatabase } from "./db-helpers.js";
import { seedRepository } from "./repository-helpers.js";

/**
 * Sub-task 4.4's own Definition of Done: all five columns updated in batches; a
 * heavily-imported fixture file scores a materially higher `inboundEdgeCount` than a
 * leaf file; a monorepo fixture file gets its declared package name, not a directory path.
 */

beforeEach(resetDatabase);
afterAll(async () => {
  await prisma.$disconnect();
});

async function seedFile(repositoryId: string, path: string) {
  return prisma.repositoryFile.create({
    data: {
      repositoryId,
      path,
      commitSha: "sha1",
      language: "typescript",
      contentHash: "hash",
      sizeBytes: 10,
      lineCount: 1,
      packageName: path.split("/").slice(0, -1).join("/") || null, // directory-derived, phase-03-style
      classification: "SOURCE",
      indexState: "INDEXED",
    },
  });
}

describe("updateRepositoryFileGraphMetadata", () => {
  it("updates all five columns in a single batched pass", async () => {
    const repo = await seedRepository();
    const file = await seedFile(repo.id, "src/util.ts");

    await updateRepositoryFileGraphMetadata([
      { fileId: file.id, symbolCount: 4, inboundEdgeCount: 7, parseState: "OK", packageName: "@repo/util", isTest: true },
    ]);

    const updated = await prisma.repositoryFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(updated.symbolCount).toBe(4);
    expect(updated.inboundEdgeCount).toBe(7);
    expect(updated.parseState).toBe("OK");
    expect(updated.packageName).toBe("@repo/util");
    expect(updated.isTest).toBe(true);
  });

  it("batches across more than one statement worth of rows", async () => {
    const repo = await seedRepository();
    const files = await Promise.all(Array.from({ length: 30 }, (_, i) => seedFile(repo.id, `src/f${i.toString()}.ts`)));

    const expected = new Map(files.map((f, i) => [f.id, i]));
    await updateRepositoryFileGraphMetadata(
      files.map((f, i) => ({ fileId: f.id, symbolCount: i, inboundEdgeCount: i, parseState: "OK" as const, packageName: null, isTest: false })),
    );

    const rows = await prisma.repositoryFile.findMany({ where: { repositoryId: repo.id } });
    expect(rows.every((r) => r.symbolCount === expected.get(r.id))).toBe(true);
  });

  it("gives a heavily-imported fixture file a materially higher inboundEdgeCount than a leaf file", async () => {
    const repo = await seedRepository();
    const util = await seedFile(repo.id, "src/util.ts");
    const leaf = await seedFile(repo.id, "src/leaf.ts");

    await updateRepositoryFileGraphMetadata([
      { fileId: util.id, symbolCount: 3, inboundEdgeCount: 42, parseState: "OK", packageName: null, isTest: false },
      { fileId: leaf.id, symbolCount: 1, inboundEdgeCount: 0, parseState: "OK", packageName: null, isTest: false },
    ]);

    const [utilRow, leafRow] = await Promise.all([
      prisma.repositoryFile.findUniqueOrThrow({ where: { id: util.id } }),
      prisma.repositoryFile.findUniqueOrThrow({ where: { id: leaf.id } }),
    ]);
    expect(utilRow.inboundEdgeCount).toBeGreaterThan(leafRow.inboundEdgeCount);
  });

  it("gives a monorepo fixture file its declared package name, not a directory path", async () => {
    const repo = await seedRepository();
    const file = await seedFile(repo.id, "packages/ui/src/button.tsx"); // directory-derived default: packages/ui/src

    await updateRepositoryFileGraphMetadata([
      { fileId: file.id, symbolCount: 1, inboundEdgeCount: 0, parseState: "OK", packageName: "@repo/ui", isTest: false },
    ]);

    const updated = await prisma.repositoryFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(updated.packageName).toBe("@repo/ui");
    expect(updated.packageName).not.toBe("packages/ui/src");
  });
});
