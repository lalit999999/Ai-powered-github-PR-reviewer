import { randomUUID } from "node:crypto";
import { prisma } from "@repo/db";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedSignedInUser, type SeededUser } from "./auth-helpers.js";
import { resetDatabase } from "./db-helpers.js";
import { githubRepoMetadata, seedInstallation } from "./repository-helpers.js";

/**
 * Prompt 5, sub-task 5.4: `GET /api/repositories/:id/knowledge` (phase-04 §7) end to end
 * through the real Express app, following `repositories.test.ts`'s established pattern —
 * GitHub mocked at the `github/services/*.github.ts` boundary, everything else real.
 *
 * The knowledge graph itself (`CodeSymbol`/`CodeDependency` rows) is seeded directly
 * through Prisma rather than by running the real tree-sitter pipeline — that pipeline
 * lives in `apps/worker` and is already covered end to end by
 * `apps/worker/tests/integration/graph-fixture.test.ts`; this file's job is proving the
 * API's aggregation, DTO shape, and tenancy — not re-proving parsing.
 */

vi.mock("../../src/inngest/emit.js", () => ({
  emitRepositoryIndexRequested: vi.fn(),
  emitProjectDeleted: vi.fn(),
}));
vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/github")>();
  return {
    ...actual,
    installationGithub: {
      listInstallationRepositories: vi.fn(),
      listUserInstallations: vi.fn(),
    },
    repositoryGithub: { getRepository: vi.fn(), probeBranch: vi.fn() },
  };
});

const { default: app } = await import("../../src/app.js");
const { repositoryGithub } = await import("@repo/github");

let user: SeededUser;

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(repositoryGithub.getRepository).mockReset();
  vi.mocked(repositoryGithub.probeBranch).mockReset();
  user = await seedSignedInUser("octocat");
  await seedInstallation(user.id, { accountLogin: "octocat" });
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function connectRepository(
  name: string,
): Promise<{ projectId: string; repositoryId: string }> {
  const projectRes = await request(app)
    .post("/api/projects")
    .set("Cookie", user.cookie)
    .send({ name: `Knowledge Test ${name}` });
  expect(projectRes.status).toBe(201);
  const projectId = projectRes.body.project.id as string;

  const metadata = githubRepoMetadata({ owner: "octocat", name });
  vi.mocked(repositoryGithub.getRepository).mockResolvedValueOnce({
    ok: true,
    repository: metadata,
  });
  const connected = await request(app)
    .post(`/api/projects/${projectId}/repositories`)
    .set("Cookie", user.cookie)
    .send({ repoUrl: `https://github.com/octocat/${name}` });
  expect(connected.status).toBe(202);

  return { projectId, repositoryId: connected.body.repository.id as string };
}

/** Seeds a small, real knowledge graph directly through Prisma — two files, three
 * symbols, and a mix of edge kinds/resolutions so every DTO field has something real to
 * assert against. */
async function seedKnowledgeGraph(repositoryId: string): Promise<void> {
  const fileA = await prisma.repositoryFile.create({
    data: {
      repositoryId,
      path: "src/a.ts",
      commitSha: "sha1",
      language: "typescript",
      contentHash: "hash-a",
      sizeBytes: 100,
      lineCount: 10,
      classification: "SOURCE",
      indexState: "INDEXED",
      parseState: "OK",
      inboundEdgeCount: 1,
    },
  });
  const fileB = await prisma.repositoryFile.create({
    data: {
      repositoryId,
      path: "src/b.ts",
      commitSha: "sha1",
      language: "typescript",
      contentHash: "hash-b",
      sizeBytes: 100,
      lineCount: 10,
      classification: "SOURCE",
      indexState: "INDEXED",
      parseState: "FAILED",
    },
  });

  const symA = await prisma.codeSymbol.create({
    data: {
      repositoryId,
      fileId: fileA.id,
      name: "a",
      kind: "FUNCTION",
      startLine: 1,
      endLine: 2,
      isExported: true,
      isDefault: false,
      complexity: 1,
      commitSha: "sha1",
    },
  });
  const symB = await prisma.codeSymbol.create({
    data: {
      repositoryId,
      fileId: fileA.id,
      name: "b",
      kind: "FUNCTION",
      startLine: 3,
      endLine: 4,
      isExported: true,
      isDefault: false,
      complexity: 1,
      commitSha: "sha1",
    },
  });

  await prisma.codeDependency.createMany({
    data: [
      {
        id: randomUUID(),
        repositoryId,
        kind: "CALLS",
        fromSymbolId: symA.id,
        toSymbolId: symB.id,
        resolution: "RESOLVED",
        confidence: 0.95,
        commitSha: "sha1",
      },
      {
        id: randomUUID(),
        repositoryId,
        kind: "IMPORTS",
        fromFileId: fileA.id,
        toFileId: fileB.id,
        resolution: "RESOLVED",
        confidence: 1,
        commitSha: "sha1",
      },
      {
        id: randomUUID(),
        repositoryId,
        kind: "IMPORTS",
        fromFileId: fileA.id,
        externalPackage: "zod",
        resolution: "EXTERNAL",
        confidence: 1,
        commitSha: "sha1",
      },
      {
        id: randomUUID(),
        repositoryId,
        kind: "IMPORTS",
        fromFileId: fileB.id,
        rawSpecifier: "./does-not-exist.js",
        resolution: "UNRESOLVED",
        confidence: 1,
        commitSha: "sha1",
      },
    ],
  });
}

describe("GET /api/repositories/:id/knowledge (phase-04 §7)", () => {
  it("200s with the correct aggregates for an owned, indexed repository", async () => {
    const { repositoryId } = await connectRepository("knowledge-owned");
    await seedKnowledgeGraph(repositoryId);

    const res = await request(app)
      .get(`/api/repositories/${repositoryId}/knowledge`)
      .set("Cookie", user.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      fileCount: 2,
      symbolCount: 2,
      edgeCount: 4,
      unresolvedImportRatio: 1 / 3,
      edgeCountByKind: { CALLS: 1, IMPORTS: 3 },
      parseStateCounts: { OK: 1, FAILED: 1 },
    });
    expect(res.body.topFilesByInboundEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/a.ts", inboundEdgeCount: 1 }),
      ]),
    );
    expect(res.body.topUnresolvedSpecifiers).toEqual([
      { rawSpecifier: "./does-not-exist.js", count: 1 },
    ]);

    // BigInt never reaches the wire — every count above is a plain JSON number, and
    // JSON.stringify itself would have thrown on a raw BigInt (RepositoryDto's own
    // precedent, apps/web/src/lib/api.ts's own doc comment on `installationId`).
    expect(() => JSON.stringify(res.body)).not.toThrow();
  });

  it("200s with all-zero aggregates for a repository with no knowledge graph yet", async () => {
    const { repositoryId } = await connectRepository("knowledge-empty");

    const res = await request(app)
      .get(`/api/repositories/${repositoryId}/knowledge`)
      .set("Cookie", user.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      fileCount: 0,
      symbolCount: 0,
      edgeCount: 0,
      unresolvedImportRatio: 0,
      topFilesByInboundEdges: [],
      topUnresolvedSpecifiers: [],
    });
  });

  it("404s for a repository belonging to another user", async () => {
    const owner = await connectRepository("knowledge-foreign");
    const otherUser = await seedSignedInUser("mallory");

    const res = await request(app)
      .get(`/api/repositories/${owner.repositoryId}/knowledge`)
      .set("Cookie", otherUser.cookie);

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty("fileCount");
  });

  it("404s for a non-existent repository id", async () => {
    const res = await request(app)
      .get("/api/repositories/00000000-0000-0000-0000-000000000000/knowledge")
      .set("Cookie", user.cookie);
    expect(res.status).toBe(404);
  });

  it("404s for a repository under a soft-deleted project", async () => {
    const { projectId, repositoryId } = await connectRepository(
      "knowledge-deleted-project",
    );

    const deleteRes = await request(app)
      .delete(`/api/projects/${projectId}`)
      .set("Cookie", user.cookie);
    expect(deleteRes.status).toBe(202);

    const res = await request(app)
      .get(`/api/repositories/${repositoryId}/knowledge`)
      .set("Cookie", user.cookie);
    expect(res.status).toBe(404);
  });
});
