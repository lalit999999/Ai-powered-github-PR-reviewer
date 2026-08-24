import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level wiring: every endpoint from phase-02 §7 is reachable at the URL the spec
 * names, unauthenticated requests get 401, and the four controller steps happen in the
 * right order.
 *
 * The session and the two module services are the seams. Mocking them keeps this a
 * *unit* test — no database, no GitHub, no Redis — while still exercising the real
 * routers, the real Zod schemas, the real `withRoute`/`errorHandler` pair, and the real
 * `mergeParams` nesting, which is exactly the layer this test exists to cover.
 */

// routes/index.ts also mounts health.routes.ts, which reaches the Prisma singleton at
// import time and would demand a DATABASE_URL. Stubbed so the *real* router tree — and
// therefore the real mount paths this test is about — can be imported with no I/O.
vi.mock("@repo/db", () => ({ prisma: {} }));

const requireSession = vi.fn();
vi.mock("../lib/auth/session.js", () => ({ requireSession: () => requireSession() }));

const requireTenantAccess = vi.fn();
vi.mock("../lib/auth/tenant-access.js", () => ({ requireTenantAccess: (...args: unknown[]) => requireTenantAccess(...args) }));

vi.mock("../modules/repositories/repository.service.js", () => ({
  connectRepository: vi.fn(),
  getRepositoryDetail: vi.fn(),
  disconnectRepository: vi.fn(),
  listInstallationRepositories: vi.fn(),
  syncInstallations: vi.fn(),
  listProjectRepositories: vi.fn(),
}));
vi.mock("../modules/projects/project.service.js", () => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  getProjectDetail: vi.fn(),
  softDeleteProject: vi.fn(),
}));

vi.mock("@repo/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/observability")>();
  return { ...actual, createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) };
});

const repositoryService = await import("../modules/repositories/repository.service.js");
const { UnauthenticatedError } = await import("../lib/errors.js");
const { errorHandler, requestContext } = await import("../lib/http.js");
const apiRoutes = (await import("./index.js")).default;

const USER_ID = "user-a";
const PROJECT_ID = "project-1";
const REPOSITORY_ID = "repo-1";

const repositoryDto = {
  id: REPOSITORY_ID,
  projectId: PROJECT_ID,
  installationId: "4242",
  githubRepoId: "1296269",
  owner: "octocat",
  name: "Hello-World",
  fullName: "octocat/Hello-World",
  defaultBranch: "main",
  isPrivate: false,
  htmlUrl: "https://github.com/octocat/Hello-World",
  sizeBytes: 110_592,
  connectionStatus: "ACTIVE" as const,
  indexStatus: "PENDING",
  indexedCommitSha: null,
  indexedFileCount: 0,
  lastIndexedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function buildApp(): Express {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use("/api", apiRoutes);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

function signedIn(): void {
  requireSession.mockResolvedValue({ user: { id: USER_ID }, expires: "2099-01-01T00:00:00.000Z" });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireTenantAccess.mockResolvedValue({ userId: USER_ID, projectId: PROJECT_ID, repositoryId: REPOSITORY_ID });
});

describe("POST /api/projects/:projectId/repositories (§7)", () => {
  it("answers 202 with the repository envelope", async () => {
    signedIn();
    vi.mocked(repositoryService.connectRepository).mockResolvedValue(repositoryDto);

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/repositories`)
      .send({ repoUrl: "https://github.com/octocat/Hello-World" });

    // 202, not 201: the row exists but the indexing it implies has only been requested.
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ repository: repositoryDto });
  });

  /**
   * The `mergeParams` guard. Express does not propagate a parent router's params into a
   * child router by default — without `Router({ mergeParams: true })`, `:projectId`
   * here would be `undefined`, silently, and tenancy would resolve against nothing.
   */
  it("receives :projectId from the parent mount — mergeParams is actually set", async () => {
    signedIn();
    vi.mocked(repositoryService.connectRepository).mockResolvedValue(repositoryDto);

    await request(app)
      .post(`/api/projects/${PROJECT_ID}/repositories`)
      .send({ repoUrl: "https://github.com/octocat/Hello-World" });

    expect(requireTenantAccess).toHaveBeenCalledWith(expect.anything(), { projectId: PROJECT_ID });
  });

  it("resolves tenancy on the project, then validates, then delegates", async () => {
    signedIn();
    vi.mocked(repositoryService.connectRepository).mockResolvedValue(repositoryDto);

    await request(app)
      .post(`/api/projects/${PROJECT_ID}/repositories`)
      .send({ githubRepoId: "1296269" });

    // The schema coerced the JSON string into a bigint before the service saw it.
    expect(repositoryService.connectRepository).toHaveBeenCalledWith(
      { userId: USER_ID, projectId: PROJECT_ID, repositoryId: REPOSITORY_ID },
      { githubRepoId: 1296269n },
    );
  });

  it("400s on a body with neither field, without touching the service", async () => {
    signedIn();

    const res = await request(app).post(`/api/projects/${PROJECT_ID}/repositories`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(repositoryService.connectRepository).not.toHaveBeenCalled();
  });

  it("400s on a body with both fields", async () => {
    signedIn();

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/repositories`)
      .send({ repoUrl: "https://github.com/octocat/Hello-World", githubRepoId: "1296269" });

    expect(res.status).toBe(400);
  });

  it("401s without a session, before any validation", async () => {
    requireSession.mockRejectedValue(new UnauthenticatedError("Authentication required"));

    const res = await request(app).post(`/api/projects/${PROJECT_ID}/repositories`).send({});

    expect(res.status).toBe(401);
    expect(requireTenantAccess).not.toHaveBeenCalled();
  });
});

describe("GET /api/repositories/:repositoryId (§7)", () => {
  it("answers 200 with { repository, indexJob: null }", async () => {
    signedIn();
    vi.mocked(repositoryService.getRepositoryDetail).mockResolvedValue({
      repository: repositoryDto,
      indexJob: null,
    });

    const res = await request(app).get(`/api/repositories/${REPOSITORY_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ repository: repositoryDto, indexJob: null });
  });

  it("resolves tenancy by repositoryId, not by projectId", async () => {
    signedIn();
    vi.mocked(repositoryService.getRepositoryDetail).mockResolvedValue({
      repository: repositoryDto,
      indexJob: null,
    });

    await request(app).get(`/api/repositories/${REPOSITORY_ID}`);

    expect(requireTenantAccess).toHaveBeenCalledWith(expect.anything(), { repositoryId: REPOSITORY_ID });
  });

  it("401s without a session", async () => {
    requireSession.mockRejectedValue(new UnauthenticatedError("Authentication required"));

    await expect(request(app).get(`/api/repositories/${REPOSITORY_ID}`)).resolves.toMatchObject({ status: 401 });
  });
});

describe("DELETE /api/repositories/:repositoryId (§7)", () => {
  it("answers 202 and echoes the repositoryId", async () => {
    signedIn();
    vi.mocked(repositoryService.disconnectRepository).mockResolvedValue(undefined);

    const res = await request(app).delete(`/api/repositories/${REPOSITORY_ID}`);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ repositoryId: REPOSITORY_ID });
  });

  it("is idempotent at the route level — a repeat call still answers 202", async () => {
    signedIn();
    vi.mocked(repositoryService.disconnectRepository).mockResolvedValue(undefined);

    await request(app).delete(`/api/repositories/${REPOSITORY_ID}`);
    const second = await request(app).delete(`/api/repositories/${REPOSITORY_ID}`);

    expect(second.status).toBe(202);
  });

  it("401s without a session", async () => {
    requireSession.mockRejectedValue(new UnauthenticatedError("Authentication required"));

    await expect(request(app).delete(`/api/repositories/${REPOSITORY_ID}`)).resolves.toMatchObject({ status: 401 });
  });
});

describe("GET /api/github/installations (§7)", () => {
  it("answers 200 with { installations }", async () => {
    signedIn();
    vi.mocked(repositoryService.syncInstallations).mockResolvedValue([
      {
        id: "inst-1",
        installationId: "4242",
        accountLogin: "octocat",
        accountType: "User",
        suspended: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const res = await request(app).get("/api/github/installations");

    expect(res.status).toBe(200);
    expect(res.body.installations).toHaveLength(1);
    expect(res.body.installations[0].installationId).toBe("4242");
  });

  it("401s without a session", async () => {
    requireSession.mockRejectedValue(new UnauthenticatedError("Authentication required"));

    await expect(request(app).get("/api/github/installations")).resolves.toMatchObject({ status: 401 });
  });
});

describe("GET /api/github/installations/:id/repos (§7)", () => {
  it("answers 200 with { repos } and passes the coerced bigint id plus ?q", async () => {
    signedIn();
    vi.mocked(repositoryService.listInstallationRepositories).mockResolvedValue([
      { githubRepoId: "1296269", fullName: "octocat/Hello-World", isPrivate: false, defaultBranch: "main" },
    ]);

    const res = await request(app).get("/api/github/installations/4242/repos?q=hello");

    expect(res.status).toBe(200);
    expect(res.body.repos).toHaveLength(1);
    expect(repositoryService.listInstallationRepositories).toHaveBeenCalledWith(
      { userId: USER_ID },
      4242n,
      { q: "hello" },
    );
  });

  it("400s on a non-numeric installation id", async () => {
    signedIn();

    const res = await request(app).get("/api/github/installations/not-a-number/repos");

    expect(res.status).toBe(400);
    expect(repositoryService.listInstallationRepositories).not.toHaveBeenCalled();
  });

  it("401s without a session", async () => {
    requireSession.mockRejectedValue(new UnauthenticatedError("Authentication required"));

    await expect(request(app).get("/api/github/installations/4242/repos")).resolves.toMatchObject({ status: 401 });
  });
});

/**
 * The failure `project.types.ts` warned about, asserted end to end: a bigint that
 * reached a DTO would make `res.json()` throw at runtime, in production, on the happy
 * path. `repository.types.test.ts` proves the conversion; this proves the wire.
 */
describe("serialization — no bigint may reach the response", () => {
  it("serializes a RepositoryDto over HTTP without throwing", async () => {
    signedIn();
    vi.mocked(repositoryService.getRepositoryDetail).mockResolvedValue({
      repository: repositoryDto,
      indexJob: null,
    });

    const res = await request(app).get(`/api/repositories/${REPOSITORY_ID}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.repository.githubRepoId).toBe("string");
    expect(typeof res.body.repository.installationId).toBe("string");
  });
});
