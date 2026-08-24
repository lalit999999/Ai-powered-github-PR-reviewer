import { prisma } from "@repo/db";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedSignedInUser, type SeededUser } from "./auth-helpers.js";
import { resetDatabase } from "./db-helpers.js";
import { assertNoTokenPersisted, githubRepoMetadata, seedInstallation, type SeededInstallation } from "./repository-helpers.js";

/**
 * Route contracts from phase-02 §7/§14/§15, driven end to end through the real Express
 * app with a real database session cookie and a real Postgres, following
 * `projects.test.ts`'s structure.
 *
 * GitHub itself is mocked at the `github/services/*.github.ts` boundary — the same
 * layer `emit.js` is mocked at in `projects.test.ts` — rather than with `nock`. The
 * GitHub *client* (token minting, retry, rate limiting, ETag caching, pagination) has
 * its own dedicated fixture suite (`src/github/github-fixtures.test.ts`); this file's
 * job is the route → controller → service → repository → Postgres pipeline, which does
 * not need a real HTTP layer underneath it to be tested honestly.
 */

vi.mock("../../src/inngest/emit.js", () => ({ emitRepositoryIndexRequested: vi.fn() }));
vi.mock("../../src/github/services/installation.github.js", () => ({
  listInstallationRepositories: vi.fn(),
  listUserInstallations: vi.fn(),
}));
vi.mock("../../src/github/services/repository.github.js", () => ({
  getRepository: vi.fn(),
  probeBranch: vi.fn(),
}));

const { emitRepositoryIndexRequested } = await import("../../src/inngest/emit.js");
const installationGithub = await import("../../src/github/services/installation.github.js");
const repositoryGithub = await import("../../src/github/services/repository.github.js");
const { default: app } = await import("../../src/app.js");

let user: SeededUser;
let installation: SeededInstallation;

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(emitRepositoryIndexRequested).mockClear();
  vi.mocked(repositoryGithub.getRepository).mockReset();
  vi.mocked(repositoryGithub.probeBranch).mockReset();
  vi.mocked(installationGithub.listUserInstallations).mockReset();
  user = await seedSignedInUser("octocat");
  installation = await seedInstallation(user.id, { accountLogin: "octocat" });
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createProject(name = "Repo Test Project"): Promise<{ id: string }> {
  const res = await request(app).post("/api/projects").set("Cookie", user.cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.project as { id: string };
}

function mockRepo(overrides: Parameters<typeof githubRepoMetadata>[0] = {}) {
  const metadata = githubRepoMetadata(overrides);
  vi.mocked(repositoryGithub.getRepository).mockResolvedValueOnce({ ok: true, repository: metadata });
  return metadata;
}

describe("authentication — every repository route is 401 without a session", () => {
  const routes: Array<["get" | "post" | "delete", string]> = [
    ["get", "/api/github/installations"],
    ["get", "/api/github/installations/507/repos"],
    ["post", "/api/projects/some-id/repositories"],
    ["get", "/api/repositories/some-id"],
    ["delete", "/api/repositories/some-id"],
  ];

  for (const [method, path] of routes) {
    it(`${method.toUpperCase()} ${path} returns 401`, async () => {
      const res = await request(app)[method](path).send({});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    });
  }
});

describe("GET /api/github/installations", () => {
  it("returns the caller's stored installations plus an installUrl built from GITHUB_APP_SLUG", async () => {
    await prisma.account.create({
      data: { userId: user.id, type: "oauth", provider: "github", providerAccountId: "gh-octocat", access_token: "fixture-oauth-token" },
    });
    vi.mocked(installationGithub.listUserInstallations).mockResolvedValueOnce({
      ok: true,
      installations: [
        { installationId: installation.installationId, accountLogin: "octocat", accountType: "User", suspended: false },
      ],
    });

    const res = await request(app).get("/api/github/installations").set("Cookie", user.cookie);

    expect(res.status).toBe(200);
    expect(res.body.installations).toHaveLength(1);
    expect(res.body.installations[0].installationId).toBe(installation.installationId.toString());
    // Sub-task 3.5: the install link's single source of truth is the API, not a
    // NEXT_PUBLIC_* variable duplicated into apps/web.
    expect(res.body.installUrl).toMatch(/^https:\/\/github\.com\/apps\/.+\/installations\/new$/);
  });
});

describe("POST /api/projects/:id/repositories — connect", () => {
  it("connects a valid repository: 202, indexStatus=PENDING, connectionStatus=ACTIVE, and emits the index-requested event", async () => {
    const project = await createProject();
    const metadata = mockRepo({ owner: "octocat", name: "hello-world" });

    const res = await request(app)
      .post(`/api/projects/${project.id}/repositories`)
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com/octocat/hello-world" });

    expect(res.status).toBe(202);
    expect(res.body.repository).toMatchObject({
      projectId: project.id,
      fullName: "octocat/hello-world",
      indexStatus: "PENDING",
      connectionStatus: "ACTIVE",
    });

    const row = await prisma.repository.findUniqueOrThrow({ where: { id: res.body.repository.id } });
    expect(row.indexStatus).toBe("PENDING");
    expect(row.connectionStatus).toBe("ACTIVE");
    expect(row.githubRepoId).toBe(metadata.githubRepoId);
    expect(row.installationId).toBe(installation.installationId);

    expect(emitRepositoryIndexRequested).toHaveBeenCalledWith({
      projectId: project.id,
      repositoryId: res.body.repository.id,
      mode: "FULL",
      reason: "connected",
    });
  });

  it("does not leak installationId/githubRepoId as anything but decimal strings (BigInt-safe DTO)", async () => {
    const project = await createProject();
    mockRepo({ owner: "octocat", name: "big-ids", githubRepoId: 9_007_199_254_740_993n });

    const res = await request(app)
      .post(`/api/projects/${project.id}/repositories`)
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com/octocat/big-ids" });

    expect(res.status).toBe(202);
    expect(typeof res.body.repository.githubRepoId).toBe("string");
    expect(res.body.repository.githubRepoId).toBe("9007199254740993");
  });

  it("bad URL: 400 with a distinct message, before any GitHub call", async () => {
    const project = await createProject();

    const res = await request(app)
      .post(`/api/projects/${project.id}/repositories`)
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com.evil.com/octocat/hello-world" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.fieldErrors.repoUrl[0]).toBe("That doesn't look like a GitHub repository URL");
    expect(repositoryGithub.getRepository).not.toHaveBeenCalled();
  });

  it("installation lacks access: 403 with a distinct message", async () => {
    const project = await createProject();
    vi.mocked(repositoryGithub.getRepository).mockResolvedValueOnce({ ok: false, reason: "NOT_ACCESSIBLE" });

    const res = await request(app)
      .post(`/api/projects/${project.id}/repositories`)
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com/octocat/private-repo" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(res.body.error.message).toBe(
      "The GitHub App doesn't have access to this repository — check your installation settings",
    );
  });

  it("empty repository: 422 with a distinct message", async () => {
    const project = await createProject();
    mockRepo({ owner: "octocat", name: "empty-repo", sizeKib: 0, defaultBranch: null });

    const res = await request(app)
      .post(`/api/projects/${project.id}/repositories`)
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com/octocat/empty-repo" });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("UNPROCESSABLE_ENTITY");
    expect(res.body.error.message).toBe("That repository is empty — push at least one commit before connecting it");
  });

  it("over the size cap: 422 with a message DISTINCT from the empty-repository one", async () => {
    const project = await createProject();
    mockRepo({ owner: "octocat", name: "huge-repo", sizeKib: 600 * 1024 });

    const res = await request(app)
      .post(`/api/projects/${project.id}/repositories`)
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com/octocat/huge-repo" });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("UNPROCESSABLE_ENTITY");
    expect(res.body.error.message).toMatch(/too large/);
    expect(res.body.error.message).not.toBe("That repository is empty — push at least one commit before connecting it");
  });

  it("same repository, same project, twice: 409 on the second, exactly one row in the database", async () => {
    const project = await createProject();
    mockRepo({ owner: "octocat", name: "repeat-repo", githubRepoId: 555_111_222n });
    mockRepo({ owner: "octocat", name: "repeat-repo", githubRepoId: 555_111_222n });

    const first = await request(app)
      .post(`/api/projects/${project.id}/repositories`)
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com/octocat/repeat-repo" });
    const second = await request(app)
      .post(`/api/projects/${project.id}/repositories`)
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com/octocat/repeat-repo" });

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("CONFLICT");

    const rows = await prisma.repository.findMany({ where: { projectId: project.id, githubRepoId: 555_111_222n } });
    expect(rows).toHaveLength(1);
  });

  it("the SAME GitHub repository connected to TWO DIFFERENT projects: both 202, two independent rows", async () => {
    const projectA = await createProject("Project A");
    const projectB = await createProject("Project B");
    mockRepo({ owner: "octocat", name: "shared-repo", githubRepoId: 777_888_999n });
    mockRepo({ owner: "octocat", name: "shared-repo", githubRepoId: 777_888_999n });

    const resA = await request(app)
      .post(`/api/projects/${projectA.id}/repositories`)
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com/octocat/shared-repo" });
    const resB = await request(app)
      .post(`/api/projects/${projectB.id}/repositories`)
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com/octocat/shared-repo" });

    expect(resA.status).toBe(202);
    expect(resB.status).toBe(202);
    expect(resA.body.repository.id).not.toBe(resB.body.repository.id);

    const rows = await prisma.repository.findMany({ where: { githubRepoId: 777_888_999n } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.projectId))).toEqual(new Set([projectA.id, projectB.id]));
  });

  it("concurrency: two simultaneous connects of the same repository to the same project produce one row and one 409", async () => {
    const project = await createProject();
    mockRepo({ owner: "octocat", name: "race-repo", githubRepoId: 424_242_424n });
    mockRepo({ owner: "octocat", name: "race-repo", githubRepoId: 424_242_424n });

    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/projects/${project.id}/repositories`)
        .set("Cookie", user.cookie)
        .send({ repoUrl: "https://github.com/octocat/race-repo" }),
      request(app)
        .post(`/api/projects/${project.id}/repositories`)
        .set("Cookie", user.cookie)
        .send({ repoUrl: "https://github.com/octocat/race-repo" }),
    ]);

    // The pre-check races and cannot be trusted to catch this alone — the unique
    // constraint is what actually holds (docs/decisions/phase-02-log.md §23).
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([202, 409]);

    const rows = await prisma.repository.findMany({ where: { projectId: project.id, githubRepoId: 424_242_424n } });
    expect(rows).toHaveLength(1);
  });

  it("returns 404 for a project the caller does not own or that never existed", async () => {
    const res = await request(app)
      .post("/api/projects/00000000-0000-0000-0000-000000000000/repositories")
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com/octocat/hello-world" });

    expect(res.status).toBe(404);
  });
});

describe("GET /api/repositories/:id", () => {
  it("returns 200 { repository, indexJob: null }", async () => {
    const project = await createProject();
    mockRepo({ owner: "octocat", name: "detail-repo" });
    const connected = await request(app)
      .post(`/api/projects/${project.id}/repositories`)
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com/octocat/detail-repo" })
      .expect(202);

    const res = await request(app)
      .get(`/api/repositories/${connected.body.repository.id}`)
      .set("Cookie", user.cookie);

    expect(res.status).toBe(200);
    expect(res.body.repository.id).toBe(connected.body.repository.id);
    expect(res.body.indexJob).toBeNull();
  });

  it("returns 404 for a repository id that was never connected", async () => {
    const res = await request(app).get("/api/repositories/never-existed").set("Cookie", user.cookie);
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/repositories/:id — disconnect", () => {
  it("sets connectionStatus=DISCONNECTED, 202, and it disappears from the project's active list", async () => {
    const project = await createProject();
    mockRepo({ owner: "octocat", name: "disconnect-me" });
    const connected = await request(app)
      .post(`/api/projects/${project.id}/repositories`)
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com/octocat/disconnect-me" })
      .expect(202);
    const repositoryId = connected.body.repository.id;

    const before = await request(app).get(`/api/projects/${project.id}`).set("Cookie", user.cookie);
    expect(before.body.repositories.map((r: { id: string }) => r.id)).toContain(repositoryId);

    const res = await request(app).delete(`/api/repositories/${repositoryId}`).set("Cookie", user.cookie);
    expect(res.status).toBe(202);

    const row = await prisma.repository.findUniqueOrThrow({ where: { id: repositoryId } });
    expect(row.connectionStatus).toBe("DISCONNECTED");

    const after = await request(app).get(`/api/projects/${project.id}`).set("Cookie", user.cookie);
    expect(after.body.repositories.map((r: { id: string }) => r.id)).not.toContain(repositoryId);
  });

  it("is idempotent — a repeat DELETE also returns 202 and does not change the row further", async () => {
    const project = await createProject();
    mockRepo({ owner: "octocat", name: "delete-twice" });
    const connected = await request(app)
      .post(`/api/projects/${project.id}/repositories`)
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com/octocat/delete-twice" })
      .expect(202);
    const repositoryId = connected.body.repository.id;

    const first = await request(app).delete(`/api/repositories/${repositoryId}`).set("Cookie", user.cookie);
    const firstUpdatedAt = (await prisma.repository.findUniqueOrThrow({ where: { id: repositoryId } })).updatedAt;

    const second = await request(app).delete(`/api/repositories/${repositoryId}`).set("Cookie", user.cookie);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const after = await prisma.repository.findUniqueOrThrow({ where: { id: repositoryId } });
    expect(after.connectionStatus).toBe("DISCONNECTED");
    expect(after.updatedAt.toISOString()).toBe(firstUpdatedAt.toISOString());
  });

  it("returns 404 for a repository that was never connected", async () => {
    const res = await request(app).delete("/api/repositories/never-existed").set("Cookie", user.cookie);
    expect(res.status).toBe(404);
  });
});

describe("Database verification (§14)", () => {
  it("GithubInstallation.userId correctly attributes the installation to the user who installed it", async () => {
    const row = await prisma.githubInstallation.findUniqueOrThrow({ where: { id: installation.id } });
    expect(row.userId).toBe(user.id);
  });

  it("no table contains anything shaped like a minted installation token, after a full connect flow", async () => {
    const project = await createProject();
    mockRepo({ owner: "octocat", name: "token-check-repo" });
    await request(app)
      .post(`/api/projects/${project.id}/repositories`)
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com/octocat/token-check-repo" })
      .expect(202);

    await assertNoTokenPersisted();
  });

  it("indexStatus is PENDING immediately after connect and no other row shape is produced this phase", async () => {
    const project = await createProject();
    mockRepo({ owner: "octocat", name: "status-check-repo" });
    await request(app)
      .post(`/api/projects/${project.id}/repositories`)
      .set("Cookie", user.cookie)
      .send({ repoUrl: "https://github.com/octocat/status-check-repo" })
      .expect(202);

    const rows = await prisma.repository.findMany({ where: { projectId: project.id } });
    expect(rows.map((r) => r.indexStatus)).toEqual(["PENDING"]);
  });
});
