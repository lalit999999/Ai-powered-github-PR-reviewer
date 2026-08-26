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

  it("creates every phase-01 table, including the Auth.js adapter tables, plus phase-02's Repository, phase-03's indexing tables, and phase-04's knowledge-graph tables", async () => {
    const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> '_prisma_migrations';`,
    );
    expect(tables.map((t) => t.table_name).sort()).toEqual([
      "Account",
      "CodeDependency",
      "CodeSymbol",
      "GithubInstallation",
      "IndexJob",
      "Project",
      "Repository",
      "RepositoryFile",
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

// Phase 03 §6/§14 Database Verification. Schema-level facts only — the fetcher,
// extractor, and persistence code that write these rows are this phase's later
// sub-tasks and Prompt 2's Inngest function, so rows here are inserted directly through
// Prisma, the same discipline the Repository block above uses.
describe("RepositoryFile + IndexJob (phase-03 §6)", () => {
  async function createRepository(slug: string, githubUserId: bigint, githubRepoId: bigint) {
    const user = await prisma.user.create({ data: { githubUserId, githubLogin: `user-${slug}` } });
    const project = await prisma.project.create({ data: { userId: user.id, name: slug, slug } });
    return prisma.repository.create({
      data: {
        projectId: project.id,
        installationId: 555_000_111n,
        githubRepoId,
        owner: "octocat",
        name: "hello-world",
        fullName: "octocat/hello-world",
        defaultBranch: "main",
        htmlUrl: "https://github.com/octocat/hello-world",
      },
    });
  }

  it("defaults a freshly inserted file to INDEXED/OK/UNKNOWN and nothing further", async () => {
    const repository = await createRepository("file-a", 3001n, 9_100_000_001n);
    const file = await prisma.repositoryFile.create({
      data: { repositoryId: repository.id, path: "src/index.ts", commitSha: "a".repeat(40), contentHash: "b".repeat(64), sizeBytes: 128 },
    });

    expect(file.indexState).toBe("INDEXED");
    expect(file.parseState).toBe("OK");
    expect(file.classification).toBe("UNKNOWN");
    expect(file.lineCount).toBe(0);
    expect(file.symbolCount).toBe(0);
    expect(file.inboundEdgeCount).toBe(0);
    expect(file.isTest).toBe(false);
    expect(file.isGenerated).toBe(false);
    expect(file.skipReason).toBeNull();
    expect(file.language).toBeNull();
    expect(file.packageName).toBeNull();
  });

  it("enforces (repositoryId, path) uniqueness — the interrupted-job idempotency guarantee", async () => {
    const repository = await createRepository("file-b", 3002n, 9_100_000_002n);
    const data = { repositoryId: repository.id, path: "src/index.ts", commitSha: "a".repeat(40), contentHash: "b".repeat(64), sizeBytes: 128 };
    await prisma.repositoryFile.create({ data });
    await expect(prisma.repositoryFile.create({ data })).rejects.toThrow();
  });

  it("cascade-deletes files and jobs when their repository is hard-deleted", async () => {
    const repository = await createRepository("file-c", 3003n, 9_100_000_003n);
    await prisma.repositoryFile.create({
      data: { repositoryId: repository.id, path: "src/index.ts", commitSha: "a".repeat(40), contentHash: "b".repeat(64), sizeBytes: 128 },
    });
    await prisma.indexJob.create({ data: { repositoryId: repository.id, mode: "FULL", status: "PENDING" } });

    await prisma.project.delete({ where: { id: (await prisma.repository.findUniqueOrThrow({ where: { id: repository.id } })).projectId } });

    expect(await prisma.repositoryFile.count()).toBe(0);
    expect(await prisma.indexJob.count()).toBe(0);
  });

  it("carries exactly the §6 columns for RepositoryFile", async () => {
    const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'RepositoryFile';`,
    );
    expect(columns.map((c) => c.column_name).sort()).toEqual(
      [
        "classification",
        "commitSha",
        "contentHash",
        "id",
        "inboundEdgeCount",
        "indexState",
        "isGenerated",
        "isTest",
        "language",
        "lineCount",
        "packageName",
        "parseState",
        "path",
        "repositoryId",
        "sizeBytes",
        "skipReason",
        "symbolCount",
        "updatedAt",
      ].sort(),
    );
  });

  it("carries exactly the §6 columns for IndexJob", async () => {
    const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'IndexJob';`,
    );
    expect(columns.map((c) => c.column_name).sort()).toEqual(
      [
        "attempts",
        "chunksEmbedded",
        "completedAt",
        "createdAt",
        "currentStep",
        "edgesCreated",
        "embeddingCacheHits",
        "error",
        "filesProcessed",
        "filesSkipped",
        "filesTotal",
        "id",
        "inngestRunId",
        "mode",
        "previousCommitSha",
        "progressPercent",
        "repositoryId",
        "startedAt",
        "status",
        "symbolsCreated",
        "targetCommitSha",
      ].sort(),
    );
  });

  it("creates the §6 indexes, including the plan.md-only (repositoryId, indexState) addition", async () => {
    const fileIndexes = (
      await prisma.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE tablename = 'RepositoryFile';`)
    ).map((i) => i.indexname);
    expect(fileIndexes).toContain("RepositoryFile_repositoryId_path_key");
    expect(fileIndexes).toContain("RepositoryFile_repositoryId_contentHash_idx");
    expect(fileIndexes).toContain("RepositoryFile_repositoryId_packageName_idx");
    // plan.md §24.2 lists this one; §6's own Prisma block does not. Asserted so the
    // addition reads as a decision (docs/decisions/phase-03-log.md) rather than a typo.
    expect(fileIndexes).toContain("RepositoryFile_repositoryId_indexState_idx");

    const jobIndexes = (
      await prisma.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE tablename = 'IndexJob';`)
    ).map((i) => i.indexname);
    expect(jobIndexes).toContain("IndexJob_repositoryId_createdAt_idx");
    expect(jobIndexes).toContain("IndexJob_status_idx");
  });

  it("declares the full FileClassification enum", async () => {
    const values = await prisma.$queryRawUnsafe<{ enumlabel: string }[]>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'FileClassification';`,
    );
    expect(values.map((v) => v.enumlabel).sort()).toEqual(
      ["ASSET", "CONFIG", "DEPENDENCY_LOCK", "DOCUMENTATION", "GENERATED", "SOURCE", "TEST", "UNKNOWN"].sort(),
    );
  });
});

// Phase 04 §6 / prompt-1 sub-task 1.3 Database Verification. Schema-level facts only —
// the parser/graph-builder that write real rows are later prompts' work; these rows are
// inserted directly through Prisma, matching the phase-02/phase-03 describe blocks above.
describe("CodeSymbol + CodeDependency (phase-04 §6)", () => {
  async function createRepositoryWithFile(slug: string, githubUserId: bigint, githubRepoId: bigint) {
    const user = await prisma.user.create({ data: { githubUserId, githubLogin: `user-${slug}` } });
    const project = await prisma.project.create({ data: { userId: user.id, name: slug, slug } });
    const repository = await prisma.repository.create({
      data: {
        projectId: project.id,
        installationId: 555_000_222n,
        githubRepoId,
        owner: "octocat",
        name: "hello-world",
        fullName: "octocat/hello-world",
        defaultBranch: "main",
        htmlUrl: "https://github.com/octocat/hello-world",
      },
    });
    const file = await prisma.repositoryFile.create({
      data: { repositoryId: repository.id, path: "src/index.ts", commitSha: "a".repeat(40), contentHash: "b".repeat(64), sizeBytes: 128 },
    });
    return { repository, file };
  }

  it("round-trips a CodeSymbol and enforces the (repositoryId, fileId, name, kind, startLine) identity constraint", async () => {
    const { repository, file } = await createRepositoryWithFile("sym-a", 4001n, 9_200_000_001n);
    const data = {
      repositoryId: repository.id,
      fileId: file.id,
      name: "login",
      kind: "FUNCTION",
      startLine: 1,
      endLine: 5,
      commitSha: "a".repeat(40),
    };
    const symbol = await prisma.codeSymbol.create({ data });
    expect(symbol.isExported).toBe(false);
    expect(symbol.isDefault).toBe(false);
    expect(symbol.complexity).toBe(0);
    expect(symbol.parentSymbolId).toBeNull();

    await expect(prisma.codeSymbol.create({ data })).rejects.toThrow();
  });

  it("cascade-deletes symbols when their repository is hard-deleted", async () => {
    const { repository, file } = await createRepositoryWithFile("sym-b", 4002n, 9_200_000_002n);
    await prisma.codeSymbol.create({
      data: { repositoryId: repository.id, fileId: file.id, name: "login", kind: "FUNCTION", startLine: 1, endLine: 5, commitSha: "a".repeat(40) },
    });

    await prisma.project.delete({ where: { id: (await prisma.repository.findUniqueOrThrow({ where: { id: repository.id } })).projectId } });

    expect(await prisma.codeSymbol.count()).toBe(0);
  });

  it("round-trips a file-level CodeDependency edge with default resolution/confidence", async () => {
    const { repository, file } = await createRepositoryWithFile("dep-a", 4003n, 9_200_000_003n);
    const edge = await prisma.codeDependency.create({
      data: { repositoryId: repository.id, kind: "IMPORTS", fromFileId: file.id, toFileId: file.id, commitSha: "a".repeat(40) },
    });
    expect(edge.resolution).toBe("RESOLVED");
    expect(edge.confidence).toBe(1.0);
    expect(edge.fromSymbolId).toBeNull();
    expect(edge.toSymbolId).toBeNull();
  });

  it("enforces the NULLS NOT DISTINCT edge-identity constraint on repeated file-level edges", async () => {
    const { repository, file } = await createRepositoryWithFile("dep-b", 4004n, 9_200_000_004n);
    const data = { repositoryId: repository.id, kind: "IMPORTS" as const, fromFileId: file.id, toFileId: file.id, commitSha: "a".repeat(40) };
    // Two file-level edges of the same kind/endpoints — both fromSymbolId/toSymbolId are
    // NULL on both rows. Without NULLS NOT DISTINCT, Postgres would treat these as
    // non-conflicting (NULL <> NULL) and allow the duplicate — phase-04 prompt-1 §2.7/§3.
    await prisma.codeDependency.create({ data });
    await expect(prisma.codeDependency.create({ data })).rejects.toThrow();
  });

  it("carries exactly the §6 columns for CodeSymbol and CodeDependency, plus the §2.6 parentSymbolId addition", async () => {
    const symbolColumns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'CodeSymbol';`,
    );
    expect(symbolColumns.map((c) => c.column_name).sort()).toEqual(
      [
        "commitSha",
        "complexity",
        "docComment",
        "endLine",
        "fileId",
        "id",
        "isDefault",
        "isExported",
        "kind",
        "name",
        "parentSymbolId",
        "repositoryId",
        "signature",
        "startLine",
      ].sort(),
    );

    const dependencyColumns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'CodeDependency';`,
    );
    expect(dependencyColumns.map((c) => c.column_name).sort()).toEqual(
      [
        "commitSha",
        "confidence",
        "externalPackage",
        "fromFileId",
        "fromSymbolId",
        "id",
        "kind",
        "rawSpecifier",
        "repositoryId",
        "resolution",
        "toFileId",
        "toSymbolId",
      ].sort(),
    );
  });

  it("creates the §6 indexes, including the §2.7 outbound-traversal addition", async () => {
    const symbolIndexes = (
      await prisma.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE tablename = 'CodeSymbol';`)
    ).map((i) => i.indexname);
    expect(symbolIndexes).toContain("CodeSymbol_fileId_idx");
    expect(symbolIndexes).toContain("CodeSymbol_repositoryId_name_idx");
    expect(symbolIndexes).toContain("CodeSymbol_repositoryId_isExported_idx");
    expect(symbolIndexes).toContain("CodeSymbol_repositoryId_fileId_name_kind_startLine_key");

    const dependencyIndexes = (
      await prisma.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE tablename = 'CodeDependency';`)
    ).map((i) => i.indexname);
    expect(dependencyIndexes).toContain("CodeDependency_repositoryId_toSymbolId_kind_idx");
    expect(dependencyIndexes).toContain("CodeDependency_repositoryId_fromFileId_kind_idx");
    expect(dependencyIndexes).toContain("CodeDependency_repositoryId_toFileId_kind_idx");
    // §2.7 — the fourth index, not in phase-04 §6's own list, added for outbound
    // traversal (plan.md §9).
    expect(dependencyIndexes).toContain("CodeDependency_repositoryId_fromSymbolId_kind_idx");
    expect(dependencyIndexes).toContain("CodeDependency_edge_identity_key");
  });

  it("declares the full DependencyKind enum", async () => {
    const values = await prisma.$queryRawUnsafe<{ enumlabel: string }[]>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'DependencyKind';`,
    );
    expect(values.map((v) => v.enumlabel).sort()).toEqual(
      ["CALLS", "CONTAINS", "EXPORTS", "EXTENDS", "IMPLEMENTS", "IMPORTS", "REFERENCES", "TESTS"].sort(),
    );
  });
});
