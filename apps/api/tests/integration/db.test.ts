import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@repo/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./db-helpers.js";

const DB_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/db");

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// Updated for phase-01 §6's field-complete models (see docs/decisions/phase-01-log.md).
// Phase-00's placeholder-only assertions ("no premature schema creep" against the
// two-column placeholder shape) no longer apply by design — Phase 01 intentionally
// supersedes them — so this file now asserts the field-complete shape instead of being
// deleted, per the migration note in phase-01-authentication-and-projects.md §6.
describe("prisma migration pipeline + field-complete models (phase-01 §6/§14)", () => {
  it("prisma migrate status reports no pending migrations after migrate deploy", () => {
    const output = execFileSync("pnpm", ["exec", "prisma", "migrate", "status"], {
      cwd: DB_PACKAGE_DIR,
      env: process.env,
      encoding: "utf-8",
    });
    expect(output).toContain("Database schema is up to date");
  });

  it("round-trips a User and a Project insert and enforces (userId, slug) uniqueness", async () => {
    const user = await prisma.user.create({
      data: { githubUserId: 1001n, githubLogin: "octocat" },
    });
    expect(user.id).toBeTruthy();
    expect(user.plan).toBe("free");
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);

    const project = await prisma.project.create({
      data: { userId: user.id, name: "Test Project", slug: "test-project" },
    });
    expect(project.id).toBeTruthy();
    expect(project.userId).toBe(user.id);
    expect(project.settings).toEqual({});
    expect(project.deletedAt).toBeNull();

    const fetchedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const fetchedProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(fetchedUser.id).toBe(user.id);
    expect(fetchedProject.userId).toBe(user.id);

    await expect(
      prisma.project.create({ data: { userId: user.id, name: "Duplicate slug", slug: "test-project" } }),
    ).rejects.toThrow();
  });

  it("creates every phase-01 table, including the Auth.js adapter tables, plus phase-02's Repository", async () => {
    const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> '_prisma_migrations';`,
    );
    expect(tables.map((t) => t.table_name).sort()).toEqual([
      "Account",
      "GithubInstallation",
      "Project",
      "Repository",
      "Session",
      "User",
      "VerificationToken",
    ]);
  });

  it("enforces the (userId, slug) unique constraint and the User identity indexes", async () => {
    const indexes = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename IN ('Project', 'User');`,
    );
    const names = indexes.map((i) => i.indexname);
    expect(names).toContain("Project_userId_slug_key");
    expect(names).toContain("Project_userId_deletedAt_idx");
    expect(names).toContain("User_githubUserId_key");
    expect(names).toContain("User_githubUserId_idx");
  });

  it("GithubInstallation exists but stays empty in this phase (phase-01 §3/§6)", async () => {
    expect(await prisma.githubInstallation.count()).toBe(0);
  });

  it("User/Project have exactly the field-complete + Auth.js adapter columns — no premature schema creep", async () => {
    const userColumns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'User' ORDER BY column_name;`,
    );
    expect(userColumns.map((c) => c.column_name).sort()).toEqual(
      [
        "avatarUrl",
        "createdAt",
        "email",
        "emailVerified",
        "githubLogin",
        "githubUserId",
        "id",
        "image",
        "name",
        "plan",
        "updatedAt",
      ].sort(),
    );

    const projectColumns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'Project' ORDER BY column_name;`,
    );
    expect(projectColumns.map((c) => c.column_name).sort()).toEqual(
      ["createdAt", "deletedAt", "id", "name", "settings", "slug", "updatedAt", "userId"].sort(),
    );
  });
});

// Phase 02 §6/§14 Database Verification. Schema-level facts only — the service and
// routes that write these rows are Prompt 2's work, so the rows here are inserted
// directly through Prisma.
describe("Repository model + IndexStatus enum (phase-02 §6)", () => {
  async function createProject(slug: string, githubUserId: bigint) {
    const user = await prisma.user.create({ data: { githubUserId, githubLogin: `user-${slug}` } });
    return prisma.project.create({ data: { userId: user.id, name: slug, slug } });
  }

  function repositoryData(projectId: string, githubRepoId: bigint) {
    return {
      projectId,
      installationId: 555_000_111n,
      githubRepoId,
      owner: "octocat",
      name: "hello-world",
      fullName: "octocat/hello-world",
      defaultBranch: "main",
      htmlUrl: "https://github.com/octocat/hello-world",
    };
  }

  it("defaults a freshly connected repository to PENDING / ACTIVE and nothing further", async () => {
    const project = await createProject("proj-a", 2001n);
    const repository = await prisma.repository.create({ data: repositoryData(project.id, 9_000_000_001n) });

    expect(repository.indexStatus).toBe("PENDING");
    expect(repository.connectionStatus).toBe("ACTIVE");
    expect(repository.isPrivate).toBe(true);
    expect(repository.indexVersion).toBe(1);
    expect(repository.indexedFileCount).toBe(0);
    expect(repository.skippedFileCount).toBe(0);
    expect(repository.settings).toEqual({});
    // Declared now, populated from Phase 03 onward (§6).
    expect(repository.indexedCommitSha).toBeNull();
    expect(repository.lastIndexedAt).toBeNull();
    expect(repository.indexError).toBeNull();
    // Additions to §6's block, argued in docs/decisions/phase-02-log.md §4.
    expect(repository.sizeBytes).toBeNull();
    expect(repository.webhookId).toBeNull();
    // BigInt columns really are bigint at the Prisma boundary — this is the first
    // model in the schema where that stops being theoretical (phase-01-log §4).
    expect(typeof repository.githubRepoId).toBe("bigint");
    expect(typeof repository.installationId).toBe("bigint");
  });

  it("allows the SAME githubRepoId under two different projects (plan.md §45 named failure point)", async () => {
    const projectA = await createProject("proj-b", 2002n);
    const projectB = await createProject("proj-c", 2003n);
    const sharedRepoId = 9_000_000_002n;

    const a = await prisma.repository.create({ data: repositoryData(projectA.id, sharedRepoId) });
    const b = await prisma.repository.create({ data: repositoryData(projectB.id, sharedRepoId) });

    expect(a.id).not.toBe(b.id);
    expect(a.githubRepoId).toBe(b.githubRepoId);
    expect(await prisma.repository.count({ where: { githubRepoId: sharedRepoId } })).toBe(2);
  });

  it("rejects the same githubRepoId twice under ONE project ((projectId, githubRepoId) unique)", async () => {
    const project = await createProject("proj-d", 2004n);
    await prisma.repository.create({ data: repositoryData(project.id, 9_000_000_003n) });
    await expect(prisma.repository.create({ data: repositoryData(project.id, 9_000_000_003n) })).rejects.toThrow();
  });

  it("cascade-deletes repositories when their project is hard-deleted", async () => {
    const project = await createProject("proj-e", 2005n);
    await prisma.repository.create({ data: repositoryData(project.id, 9_000_000_004n) });
    await prisma.project.delete({ where: { id: project.id } });
    expect(await prisma.repository.count()).toBe(0);
  });

  it("carries exactly the §6 columns plus the three documented additions", async () => {
    const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'Repository';`,
    );
    expect(columns.map((c) => c.column_name).sort()).toEqual(
      [
        "connectionStatus",
        "createdAt",
        "defaultBranch",
        "fullName",
        "githubRepoId",
        "htmlUrl",
        "id",
        "indexError",
        "indexStatus",
        "indexVersion",
        "indexedCommitSha",
        "indexedFileCount",
        "installationId",
        "isPrivate",
        "lastIndexedAt",
        "name",
        "owner",
        "projectId",
        "reviewProfile",
        "settings",
        "sizeBytes",
        "skippedFileCount",
        "updatedAt",
        "webhookId",
      ].sort(),
    );
  });

  it("creates the §6 indexes and no standalone projectId index", async () => {
    const indexes = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'Repository';`,
    );
    const names = indexes.map((i) => i.indexname);
    expect(names).toContain("Repository_projectId_githubRepoId_key");
    expect(names).toContain("Repository_githubRepoId_idx");
    expect(names).toContain("Repository_indexStatus_idx");
    // plan.md §24.2 asks for @@index([projectId]); §6 does not, because the composite
    // unique above is already projectId-prefixed. Asserted so the omission reads as a
    // decision (docs/decisions/phase-02-log.md §4) rather than an oversight.
    expect(names).not.toContain("Repository_projectId_idx");
  });

  it("declares the full IndexStatus enum even though only PENDING is reachable this phase", async () => {
    const values = await prisma.$queryRawUnsafe<{ enumlabel: string }[]>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'IndexStatus';`,
    );
    expect(values.map((v) => v.enumlabel).sort()).toEqual(
      ["FAILED", "INDEXED", "INDEXING", "PARTIAL", "PENDING", "UPDATING"].sort(),
    );
  });
});
