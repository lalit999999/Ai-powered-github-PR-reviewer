import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubRepositoryMetadata } from "@repo/github";
import type {
  InstallationRecord,
  RepositoryRecord,
} from "./repository.types.js";

/**
 * The seams: the two repository files (they own the Prisma import), the two GitHub
 * service wrappers, emit.ts, and — Phase 03 — index-job.repository.ts (Prisma) and
 * rate-limit.ts (Redis, via lib/redis.ts's own real `config/env.js` import — mocked
 * directly here rather than letting the test reach `lib/redis.ts` for real, matching
 * emit.js's own treatment). All hoisted above the imports below, so neither @repo/db,
 * the config module, nor a socket is ever touched.
 *
 * `@repo/github` is mocked with `importOriginal` — a narrow replacement broke the moment
 * this file started transitively reaching `lib/config.ts` (via `lib/rate-limit.js` in a
 * naive first draft), which imports `githubAppPrivateKeySchema` from this same package;
 * see docs/decisions/phase-03-log.md, and phase-03-log.md's Prompt 1 section for the
 * identical `@repo/observability` lesson this repeats.
 */
vi.mock("./repository.repository.js", () => ({
  findByIdForProject: vi.fn(),
  findByProjectAndGithubRepoId: vi.fn(),
  listByProject: vi.fn(),
  create: vi.fn(),
  markDisconnected: vi.fn(),
  markAccessLost: vi.fn(),
}));
vi.mock("./installation.repository.js", () => ({
  upsertInstallation: vi.fn(),
  listInstallationsForUser: vi.fn(),
  findInstallationForUser: vi.fn(),
  findGithubAccessToken: vi.fn(),
}));
vi.mock("./index-job.repository.js", () => ({
  findLatestForRepository: vi.fn(),
}));
vi.mock("./knowledge.repository.js", () => ({
  getKnowledgeAggregates: vi.fn(),
}));
// Prompt 4 sub-task 4.3's listRecentWebhookDeliveries is the only function in this file
// that touches the webhooks module's own repository — stubbed here purely so the module
// graph resolves without a real @repo/db import; its own behavior is covered by this
// file's "listRecentWebhookDeliveries" describe block below.
vi.mock("../webhooks/webhook-event.repository.js", () => ({
  listRecentByRepositoryFullName: vi.fn(),
}));
vi.mock("../../lib/rate-limit.js", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@repo/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/github")>()),
  installationGithub: {
    listUserInstallations: vi.fn(),
    listInstallationRepositories: vi.fn(),
  },
  repositoryGithub: {
    getRepository: vi.fn(),
    probeBranch: vi.fn(),
  },
}));
vi.mock("../../inngest/emit.js", () => ({
  emitRepositoryIndexRequested: vi.fn(),
}));

const logSpies = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
vi.mock("@repo/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/observability")>();
  return { ...actual, createLogger: () => logSpies };
});

const repositoryRepository = await import("./repository.repository.js");
const installationRepository = await import("./installation.repository.js");
const indexJobRepository = await import("./index-job.repository.js");
const knowledgeRepository = await import("./knowledge.repository.js");
const webhookEventRepository =
  await import("../webhooks/webhook-event.repository.js");
const { checkRateLimit } = await import("../../lib/rate-limit.js");
const { installationGithub, repositoryGithub } = await import("@repo/github");
const { emitRepositoryIndexRequested } = await import("../../inngest/emit.js");
const {
  ConflictError,
  ForbiddenError,
  InternalError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthenticatedError,
  UnprocessableEntityError,
} = await import("../../lib/errors.js");
const {
  connectRepository,
  disconnectRepository,
  getIndexStatus,
  getKnowledge,
  getRepositoryDetail,
  listInstallationRepositories,
  listRecentWebhookDeliveries,
  syncInstallations,
  triggerIndex,
} = await import("./repository.service.js");

const USER_ID = "user-a";
const PROJECT_ID = "project-1";
const OWNER = { userId: USER_ID };
const TENANT = { userId: USER_ID, projectId: PROJECT_ID };
const INSTALLATION_ID = 4242n;
const GITHUB_REPO_ID = 1296269n;

const mockedListInstallations = vi.mocked(
  installationRepository.listInstallationsForUser,
);
const mockedFindInstallation = vi.mocked(
  installationRepository.findInstallationForUser,
);
const mockedFindToken = vi.mocked(installationRepository.findGithubAccessToken);
const mockedUpsertInstallation = vi.mocked(
  installationRepository.upsertInstallation,
);
const mockedListUserInstallations = vi.mocked(
  installationGithub.listUserInstallations,
);
const mockedListInstallationRepos = vi.mocked(
  installationGithub.listInstallationRepositories,
);
const mockedGetRepository = vi.mocked(repositoryGithub.getRepository);
const mockedProbeBranch = vi.mocked(repositoryGithub.probeBranch);
const mockedFindByPair = vi.mocked(
  repositoryRepository.findByProjectAndGithubRepoId,
);
const mockedCreate = vi.mocked(repositoryRepository.create);
const mockedMarkDisconnected = vi.mocked(repositoryRepository.markDisconnected);
const mockedFindByIdForProject = vi.mocked(
  repositoryRepository.findByIdForProject,
);
const mockedFindLatestIndexJob = vi.mocked(
  indexJobRepository.findLatestForRepository,
);
const mockedGetKnowledgeAggregates = vi.mocked(
  knowledgeRepository.getKnowledgeAggregates,
);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);

function installationRow(
  overrides: Partial<InstallationRecord> = {},
): InstallationRecord {
  return {
    id: "inst-1",
    installationId: INSTALLATION_ID,
    accountLogin: "octocat",
    accountType: "User",
    userId: USER_ID,
    suspendedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function metadata(
  overrides: Partial<GithubRepositoryMetadata> = {},
): GithubRepositoryMetadata {
  return {
    githubRepoId: GITHUB_REPO_ID,
    owner: "octocat",
    name: "Hello-World",
    fullName: "octocat/Hello-World",
    defaultBranch: "main",
    isPrivate: false,
    htmlUrl: "https://github.com/octocat/Hello-World",
    sizeKib: 108,
    archived: false,
    disabled: false,
    ...overrides,
  };
}

function repositoryRow(
  overrides: Partial<RepositoryRecord> = {},
): RepositoryRecord {
  return {
    id: "repo-1",
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    githubRepoId: GITHUB_REPO_ID,
    owner: "octocat",
    name: "Hello-World",
    fullName: "octocat/Hello-World",
    defaultBranch: "main",
    isPrivate: false,
    htmlUrl: "https://github.com/octocat/Hello-World",
    sizeBytes: 110_592,
    connectionStatus: "ACTIVE",
    indexStatus: "PENDING",
    indexedCommitSha: null,
    indexVersion: 1,
    indexedFileCount: 0,
    skippedFileCount: 0,
    lastIndexedAt: null,
    indexError: null,
    settings: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** The default happy-path wiring: one installation on `octocat`, a healthy repo, no
 * existing connection, a successful insert. */
function arrangeHappyPath(): void {
  mockedListInstallations.mockResolvedValue([installationRow()]);
  mockedGetRepository.mockResolvedValue({ ok: true, repository: metadata() });
  mockedFindByPair.mockResolvedValue(null);
  mockedCreate.mockResolvedValue({ ok: true, repository: repositoryRow() });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("connectRepository — the happy path (§7, §21)", () => {
  it("creates a PENDING repository and returns its DTO", async () => {
    arrangeHappyPath();

    const dto = await connectRepository(TENANT, {
      repoUrl: "https://github.com/octocat/Hello-World",
    });

    expect(dto.id).toBe("repo-1");
    expect(dto.indexStatus).toBe("PENDING");
    expect(dto.connectionStatus).toBe("ACTIVE");
    // The bigints crossed the DTO boundary as strings.
    expect(dto.githubRepoId).toBe("1296269");
    expect(dto.installationId).toBe("4242");
  });

  it("calls GET /repos exactly once per connect attempt — the §21 cost lever", async () => {
    arrangeHappyPath();

    await connectRepository(TENANT, {
      repoUrl: "https://github.com/octocat/Hello-World",
    });

    expect(mockedGetRepository).toHaveBeenCalledTimes(1);
    // And never probes for emptiness when the repository has content.
    expect(mockedProbeBranch).not.toHaveBeenCalled();
  });

  it("stores CANONICAL values from GitHub's response, not from the user's URL", async () => {
    // The user typed the wrong case. GitHub lookups are case-insensitive, so this
    // resolves — and storing the typed spelling would produce a row that matches
    // nothing GitHub ever sends back, including Phase 06's webhook payloads.
    arrangeHappyPath();

    await connectRepository(TENANT, {
      repoUrl: "https://github.com/OCTOCAT/hello-world",
    });

    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "octocat",
        name: "Hello-World",
        fullName: "octocat/Hello-World",
        defaultBranch: "main",
        htmlUrl: "https://github.com/octocat/Hello-World",
      }),
    );
  });

  it("converts GitHub's KiB size into the sizeBytes column's own unit", async () => {
    // phase-02-log §4 flagged this mismatch explicitly: the column says bytes, the
    // source is KiB, and Prompt 2 had to pick one and be consistent.
    arrangeHappyPath();

    await connectRepository(TENANT, {
      repoUrl: "https://github.com/octocat/Hello-World",
    });

    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({ sizeBytes: 108 * 1024 }),
    );
  });

  it("emits repository/index.requested with the §8 payload", async () => {
    arrangeHappyPath();

    await connectRepository(TENANT, {
      repoUrl: "https://github.com/octocat/Hello-World",
    });

    expect(emitRepositoryIndexRequested).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      repositoryId: "repo-1",
      mode: "FULL",
      reason: "connected",
    });
  });

  it("logs the success with repositoryId, projectId, userId and installationId (§20)", async () => {
    arrangeHappyPath();

    await connectRepository(TENANT, {
      repoUrl: "https://github.com/octocat/Hello-World",
    });

    expect(logSpies.info).toHaveBeenCalledWith(
      "repository connected",
      expect.objectContaining({
        repositoryId: "repo-1",
        projectId: PROJECT_ID,
        userId: USER_ID,
        installationId: "4242",
      }),
    );
  });

  it("resolves the installation from the URL's owner, without a GitHub listing call", async () => {
    arrangeHappyPath();

    await connectRepository(TENANT, {
      repoUrl: "https://github.com/octocat/Hello-World",
    });

    expect(mockedListInstallationRepos).not.toHaveBeenCalled();
    expect(mockedGetRepository).toHaveBeenCalledWith(
      INSTALLATION_ID,
      "octocat",
      "Hello-World",
    );
  });
});

describe("connectRepository — the picker's githubRepoId path", () => {
  it("finds the repository through the user's own installations and connects it", async () => {
    mockedListInstallations.mockResolvedValue([installationRow()]);
    mockedListInstallationRepos.mockResolvedValue({
      ok: true,
      repositories: [
        {
          githubRepoId: GITHUB_REPO_ID,
          owner: "octocat",
          name: "Hello-World",
          fullName: "octocat/Hello-World",
          isPrivate: false,
          defaultBranch: "main",
        },
      ],
    });
    mockedGetRepository.mockResolvedValue({ ok: true, repository: metadata() });
    mockedFindByPair.mockResolvedValue(null);
    mockedCreate.mockResolvedValue({ ok: true, repository: repositoryRow() });

    const dto = await connectRepository(TENANT, {
      githubRepoId: GITHUB_REPO_ID,
    });

    expect(dto.id).toBe("repo-1");
    expect(mockedGetRepository).toHaveBeenCalledWith(
      INSTALLATION_ID,
      "octocat",
      "Hello-World",
    );
  });

  it("rejects an id no installation of this user can see, with the 403 message", async () => {
    // §13: access is verified through the installation, never trusted from client
    // input — so an id the user simply guessed goes nowhere.
    mockedListInstallations.mockResolvedValue([installationRow()]);
    mockedListInstallationRepos.mockResolvedValue({
      ok: true,
      repositories: [],
    });

    await expect(
      connectRepository(TENANT, { githubRepoId: 999999n }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockedGetRepository).not.toHaveBeenCalled();
  });
});

describe("connectRepository — each failure is its own answer (§4, §15)", () => {
  it("400 for a URL that does not parse", async () => {
    mockedListInstallations.mockResolvedValue([installationRow()]);

    await expect(
      connectRepository(TENANT, { repoUrl: "https://github.com.evil.com/o/r" }),
    ).rejects.toMatchObject({
      httpStatus: 400,
    });
    expect(mockedGetRepository).not.toHaveBeenCalled();
  });

  it("403 when the App has no installation on that account", async () => {
    mockedListInstallations.mockResolvedValue([
      installationRow({ accountLogin: "someone-else" }),
    ]);

    await expect(
      connectRepository(TENANT, {
        repoUrl: "https://github.com/octocat/Hello-World",
      }),
    ).rejects.toMatchObject({ httpStatus: 403 });
  });

  it("403 when GitHub answers 404 for a repository the installation cannot see", async () => {
    mockedListInstallations.mockResolvedValue([installationRow()]);
    mockedGetRepository.mockResolvedValue({
      ok: false,
      reason: "NOT_ACCESSIBLE",
    });

    const thrown = await connectRepository(TENANT, {
      repoUrl: "https://github.com/octocat/secret",
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ForbiddenError);
    expect((thrown as Error).message).toMatch(/installation settings/i);
  });

  it("503, not 403, when GitHub is simply unavailable", async () => {
    mockedListInstallations.mockResolvedValue([installationRow()]);
    mockedGetRepository.mockResolvedValue({ ok: false, reason: "UNAVAILABLE" });

    await expect(
      connectRepository(TENANT, {
        repoUrl: "https://github.com/octocat/Hello-World",
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it("409 when the repository is already connected to THIS project", async () => {
    mockedListInstallations.mockResolvedValue([installationRow()]);
    mockedGetRepository.mockResolvedValue({ ok: true, repository: metadata() });
    mockedFindByPair.mockResolvedValue(repositoryRow());

    await expect(
      connectRepository(TENANT, {
        repoUrl: "https://github.com/octocat/Hello-World",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("409 when the pre-check races and the unique constraint is what holds", async () => {
    // Two simultaneous connects both see "not connected"; only the constraint
    // actually prevents the duplicate. Same answer either way.
    mockedListInstallations.mockResolvedValue([installationRow()]);
    mockedGetRepository.mockResolvedValue({ ok: true, repository: metadata() });
    mockedFindByPair.mockResolvedValue(null);
    mockedCreate.mockResolvedValue({ ok: false, reason: "ALREADY_CONNECTED" });

    await expect(
      connectRepository(TENANT, {
        repoUrl: "https://github.com/octocat/Hello-World",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(emitRepositoryIndexRequested).not.toHaveBeenCalled();
  });

  it("422 for an empty repository", async () => {
    mockedListInstallations.mockResolvedValue([installationRow()]);
    mockedGetRepository.mockResolvedValue({
      ok: true,
      repository: metadata({ sizeKib: 0, defaultBranch: null }),
    });
    mockedFindByPair.mockResolvedValue(null);

    await expect(
      connectRepository(TENANT, {
        repoUrl: "https://github.com/octocat/Hello-World",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("422 for a repository over the size cap", async () => {
    mockedListInstallations.mockResolvedValue([installationRow()]);
    mockedGetRepository.mockResolvedValue({
      ok: true,
      repository: metadata({ sizeKib: 600 * 1024 }),
    });
    mockedFindByPair.mockResolvedValue(null);

    const thrown = await connectRepository(TENANT, {
      repoUrl: "https://github.com/octocat/Hello-World",
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(UnprocessableEntityError);
    expect((thrown as Error).message).toMatch(/too large/i);
  });

  it("probes only for an ambiguous size 0, and connects a freshly pushed repository", async () => {
    mockedListInstallations.mockResolvedValue([installationRow()]);
    mockedGetRepository.mockResolvedValue({
      ok: true,
      repository: metadata({ sizeKib: 0, defaultBranch: "main" }),
    });
    mockedFindByPair.mockResolvedValue(null);
    mockedProbeBranch.mockResolvedValue("HAS_COMMITS");
    mockedCreate.mockResolvedValue({ ok: true, repository: repositoryRow() });

    await expect(
      connectRepository(TENANT, {
        repoUrl: "https://github.com/octocat/Hello-World",
      }),
    ).resolves.toMatchObject({ id: "repo-1" });
    expect(mockedProbeBranch).toHaveBeenCalledWith(
      INSTALLATION_ID,
      "octocat",
      "Hello-World",
      "main",
    );
  });
});

/**
 * §15's explicit acceptance criterion and plan.md §45's named Phase 2 failure mode.
 * This test fails if anyone introduces a global `githubRepoId` uniqueness check.
 */
describe("connectRepository — the same repository under a DIFFERENT project (§4, §15)", () => {
  it("connects cleanly, because the lookup keys on (projectId, githubRepoId)", async () => {
    mockedListInstallations.mockResolvedValue([installationRow()]);
    mockedGetRepository.mockResolvedValue({ ok: true, repository: metadata() });
    // Already connected under project-1; project-2's lookup finds nothing.
    mockedFindByPair.mockResolvedValue(null);
    mockedCreate.mockResolvedValue({
      ok: true,
      repository: repositoryRow({ id: "repo-2", projectId: "project-2" }),
    });

    const dto = await connectRepository(
      { userId: USER_ID, projectId: "project-2" },
      { repoUrl: "https://github.com/octocat/Hello-World" },
    );

    expect(dto.id).toBe("repo-2");
    expect(mockedFindByPair).toHaveBeenCalledWith("project-2", GITHUB_REPO_ID);
    // Never queried by githubRepoId alone — that is the failure mode.
    expect(mockedFindByPair).not.toHaveBeenCalledWith(GITHUB_REPO_ID);
  });
});

function indexJobRow(
  overrides: Partial<
    Awaited<ReturnType<typeof indexJobRepository.findLatestForRepository>>
  > = {},
) {
  return {
    id: "job-1",
    repositoryId: "repo-1",
    mode: "FULL",
    status: "RUNNING",
    currentStep: "extract-filter-hash",
    progressPercent: 35,
    filesTotal: 0,
    filesProcessed: 0,
    filesSkipped: 0,
    error: null,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("getRepositoryDetail", () => {
  it("returns indexJob null when the repository has never had an index job", async () => {
    mockedFindByIdForProject.mockResolvedValue(repositoryRow());
    mockedFindLatestIndexJob.mockResolvedValue(null);

    const detail = await getRepositoryDetail({
      ...TENANT,
      repositoryId: "repo-1",
    });

    expect(detail.indexJob).toBeNull();
    expect(detail.repository.id).toBe("repo-1");
  });

  it("returns the latest IndexJob summarized as indexJob", async () => {
    mockedFindByIdForProject.mockResolvedValue(repositoryRow());
    mockedFindLatestIndexJob.mockResolvedValue(indexJobRow());

    const detail = await getRepositoryDetail({
      ...TENANT,
      repositoryId: "repo-1",
    });

    expect(detail.indexJob).toEqual({
      id: "job-1",
      status: "RUNNING",
      currentStep: "extract-filter-hash",
      progressPercent: 35,
      filesTotal: 0,
      filesProcessed: 0,
      filesSkipped: 0,
      error: null,
    });
  });

  it("re-reads through the project-scoped query rather than trusting the tenancy proof", async () => {
    mockedFindByIdForProject.mockResolvedValue(repositoryRow());

    await getRepositoryDetail({ ...TENANT, repositoryId: "repo-1" });

    expect(mockedFindByIdForProject).toHaveBeenCalledWith(PROJECT_ID, "repo-1");
  });

  it("404s if the repository vanished between the tenancy check and the read", async () => {
    mockedFindByIdForProject.mockResolvedValue(null);

    await expect(
      getRepositoryDetail({ ...TENANT, repositoryId: "repo-1" }),
    ).rejects.toMatchObject({
      httpStatus: 404,
    });
  });
});

describe("listRecentWebhookDeliveries (phase-06 §7 — POST /webhook-test, despite the name)", () => {
  it("resolves the repository's fullName then reads by it, not by repositoryId", async () => {
    mockedFindByIdForProject.mockResolvedValue(
      repositoryRow({ fullName: "octocat/hello-world" }),
    );
    vi.mocked(
      webhookEventRepository.listRecentByRepositoryFullName,
    ).mockResolvedValue([]);

    await listRecentWebhookDeliveries({ ...TENANT, repositoryId: "repo-1" });

    expect(
      webhookEventRepository.listRecentByRepositoryFullName,
    ).toHaveBeenCalledWith("octocat/hello-world", expect.any(Number));
  });

  it("maps rows through toWebhookDeliveryDto — no bigint, dates as ISO strings", async () => {
    mockedFindByIdForProject.mockResolvedValue(repositoryRow());
    vi.mocked(
      webhookEventRepository.listRecentByRepositoryFullName,
    ).mockResolvedValue([
      {
        id: "event-1",
        deliveryId: "d-1",
        eventType: "pull_request",
        action: "opened",
        status: "DISPATCHED",
        dispatchedAt: new Date("2026-01-01T00:00:00.000Z"),
        error: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const result = await listRecentWebhookDeliveries({
      ...TENANT,
      repositoryId: "repo-1",
    });

    expect(result).toEqual([
      {
        id: "event-1",
        deliveryId: "d-1",
        eventType: "pull_request",
        action: "opened",
        status: "DISPATCHED",
        dispatchedAt: "2026-01-01T00:00:00.000Z",
        error: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("404s if the repository vanished between the tenancy check and the read", async () => {
    mockedFindByIdForProject.mockResolvedValue(null);

    await expect(
      listRecentWebhookDeliveries({ ...TENANT, repositoryId: "repo-1" }),
    ).rejects.toMatchObject({
      httpStatus: 404,
    });
    expect(
      webhookEventRepository.listRecentByRepositoryFullName,
    ).not.toHaveBeenCalled();
  });
});

describe("getIndexStatus (§7 — the cheap polling endpoint)", () => {
  it("falls back to the Repository row's own indexStatus/indexError when no IndexJob exists yet", async () => {
    mockedFindByIdForProject.mockResolvedValue(
      repositoryRow({ indexStatus: "PENDING", indexError: null }),
    );
    mockedFindLatestIndexJob.mockResolvedValue(null);

    const status = await getIndexStatus({ ...TENANT, repositoryId: "repo-1" });

    expect(status).toEqual({
      status: "PENDING",
      currentStep: null,
      progressPercent: 0,
      filesTotal: 0,
      filesProcessed: 0,
      error: null,
    });
  });

  it("returns the latest IndexJob's fields, and only the six §7 names (no id, no filesSkipped)", async () => {
    mockedFindByIdForProject.mockResolvedValue(repositoryRow());
    mockedFindLatestIndexJob.mockResolvedValue(
      indexJobRow({ filesTotal: 100, filesProcessed: 60, filesSkipped: 10 }),
    );

    const status = await getIndexStatus({ ...TENANT, repositoryId: "repo-1" });

    expect(status).toEqual({
      status: "RUNNING",
      currentStep: "extract-filter-hash",
      progressPercent: 35,
      filesTotal: 100,
      filesProcessed: 60,
      error: null,
    });
    expect(status).not.toHaveProperty("id");
    expect(status).not.toHaveProperty("filesSkipped");
  });

  it("404s if the repository vanished", async () => {
    mockedFindByIdForProject.mockResolvedValue(null);

    await expect(
      getIndexStatus({ ...TENANT, repositoryId: "repo-1" }),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("getKnowledge (phase-04 §7 — the knowledge/debug panel's one read)", () => {
  it("re-verifies ownership through findByIdForProject, then returns the DTO the repository layer's aggregates produce", async () => {
    mockedFindByIdForProject.mockResolvedValue(repositoryRow());
    mockedGetKnowledgeAggregates.mockResolvedValue({
      fileTotals: { fileCount: 3, parseStateCounts: { OK: 2, FAILED: 1 } },
      symbolCount: 12,
      edgeTotals: {
        edgeCount: 20,
        edgeCountByKind: { CALLS: 15, IMPORTS: 5 },
        unresolvedImportRatio: 0.2,
      },
      topUnresolvedSpecifiers: [{ rawSpecifier: "./missing.js", count: 1 }],
      topFilesByInboundEdges: [
        { fileId: "file-1", path: "src/a.ts", inboundEdgeCount: 4 },
      ],
    });

    const knowledge = await getKnowledge({ ...TENANT, repositoryId: "repo-1" });

    expect(mockedFindByIdForProject).toHaveBeenCalledWith(PROJECT_ID, "repo-1");
    expect(mockedGetKnowledgeAggregates).toHaveBeenCalledWith("repo-1");
    expect(knowledge).toEqual({
      fileCount: 3,
      symbolCount: 12,
      edgeCount: 20,
      unresolvedImportRatio: 0.2,
      topFilesByInboundEdges: [
        { fileId: "file-1", path: "src/a.ts", inboundEdgeCount: 4 },
      ],
      edgeCountByKind: { CALLS: 15, IMPORTS: 5 },
      parseStateCounts: { OK: 2, FAILED: 1 },
      topUnresolvedSpecifiers: [{ rawSpecifier: "./missing.js", count: 1 }],
    });
  });

  it("404s if the repository vanished, and never runs the aggregate queries", async () => {
    mockedFindByIdForProject.mockResolvedValue(null);

    await expect(
      getKnowledge({ ...TENANT, repositoryId: "repo-1" }),
    ).rejects.toMatchObject({ httpStatus: 404 });
    expect(mockedGetKnowledgeAggregates).not.toHaveBeenCalled();
  });
});

describe("triggerIndex (§7 — POST /index)", () => {
  beforeEach(() => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: true });
  });

  it("emits repository/index.requested with a pre-allocated indexJobId and returns it", async () => {
    mockedFindByIdForProject.mockResolvedValue(
      repositoryRow({ indexStatus: "PENDING" }),
    );

    const result = await triggerIndex(
      { ...TENANT, repositoryId: "repo-1" },
      { mode: "FULL" },
    );

    expect(result.indexJobId).toEqual(expect.any(String));
    expect(emitRepositoryIndexRequested).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      repositoryId: "repo-1",
      mode: "FULL",
      reason: "manual",
      indexJobId: result.indexJobId,
    });
  });

  it("409s when the repository is already indexing", async () => {
    mockedFindByIdForProject.mockResolvedValue(
      repositoryRow({ indexStatus: "INDEXING" }),
    );

    await expect(
      triggerIndex({ ...TENANT, repositoryId: "repo-1" }, { mode: "FULL" }),
    ).rejects.toMatchObject({
      httpStatus: 409,
    });
    expect(emitRepositoryIndexRequested).not.toHaveBeenCalled();
  });

  it("429s when the rate limit rejects, carrying retryAfterSeconds in details", async () => {
    mockedFindByIdForProject.mockResolvedValue(
      repositoryRow({ indexStatus: "PENDING" }),
    );
    mockedCheckRateLimit.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 1800,
    });

    await expect(
      triggerIndex({ ...TENANT, repositoryId: "repo-1" }, { mode: "FULL" }),
    ).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(emitRepositoryIndexRequested).not.toHaveBeenCalled();
    // Repository lookup must not even run once the rate limit has already rejected.
    expect(mockedFindByIdForProject).not.toHaveBeenCalled();
  });

  it("404s if the repository vanished", async () => {
    mockedFindByIdForProject.mockResolvedValue(null);

    await expect(
      triggerIndex({ ...TENANT, repositoryId: "repo-1" }, { mode: "FULL" }),
    ).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it("rejects a non-FULL mode defensively, even though the schema layer already rejects it", async () => {
    await expect(
      triggerIndex(
        { ...TENANT, repositoryId: "repo-1" },
        { mode: "INCREMENTAL" as "FULL" },
      ),
    ).rejects.toBeInstanceOf(InternalError);
    expect(emitRepositoryIndexRequested).not.toHaveBeenCalled();
  });
});

describe("disconnectRepository — idempotent (§7, §11)", () => {
  it("logs the transition when a row actually changed", async () => {
    mockedMarkDisconnected.mockResolvedValue(1);

    await expect(
      disconnectRepository({ ...TENANT, repositoryId: "repo-1" }),
    ).resolves.toBeUndefined();

    expect(logSpies.info).toHaveBeenCalledWith("repository disconnected", {
      repositoryId: "repo-1",
      projectId: PROJECT_ID,
      userId: USER_ID,
    });
  });

  it("succeeds on a repeat call without overwriting the original transition", async () => {
    mockedMarkDisconnected.mockResolvedValue(0);

    await expect(
      disconnectRepository({ ...TENANT, repositoryId: "repo-1" }),
    ).resolves.toBeUndefined();

    expect(logSpies.info).toHaveBeenCalledWith(
      "repository disconnect no-op (already disconnected)",
      expect.objectContaining({ repositoryId: "repo-1" }),
    );
  });
});

describe("listInstallationRepositories — installation ownership is checked server-side (§13)", () => {
  it("rejects an installation the caller does not own, before any GitHub call", async () => {
    mockedFindInstallation.mockResolvedValue(null);

    await expect(
      listInstallationRepositories(OWNER, 999n, { q: undefined }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockedListInstallationRepos).not.toHaveBeenCalled();
  });

  it("cross-checks against GithubInstallation.userId rather than trusting the id", async () => {
    mockedFindInstallation.mockResolvedValue(installationRow());
    mockedListInstallationRepos.mockResolvedValue({
      ok: true,
      repositories: [],
    });

    await listInstallationRepositories(OWNER, INSTALLATION_ID, {
      q: undefined,
    });

    expect(mockedFindInstallation).toHaveBeenCalledWith(
      USER_ID,
      INSTALLATION_ID,
    );
  });

  it("applies ?q server-side, case-insensitively", async () => {
    mockedFindInstallation.mockResolvedValue(installationRow());
    mockedListInstallationRepos.mockResolvedValue({
      ok: true,
      repositories: [
        {
          githubRepoId: 1n,
          owner: "octocat",
          name: "api",
          fullName: "octocat/api",
          isPrivate: true,
          defaultBranch: "main",
        },
        {
          githubRepoId: 2n,
          owner: "octocat",
          name: "web",
          fullName: "octocat/web",
          isPrivate: false,
          defaultBranch: "main",
        },
      ],
    });

    const repos = await listInstallationRepositories(OWNER, INSTALLATION_ID, {
      q: "API",
    });

    expect(repos).toEqual([
      {
        githubRepoId: "1",
        fullName: "octocat/api",
        isPrivate: true,
        defaultBranch: "main",
      },
    ]);
  });
});

describe("syncInstallations — the temporary polling fallback (§10)", () => {
  it("upserts a row per installation and returns the DTOs", async () => {
    mockedFindToken.mockResolvedValue("gho_token");
    mockedListUserInstallations.mockResolvedValue({
      ok: true,
      installations: [
        {
          installationId: INSTALLATION_ID,
          accountLogin: "octocat",
          accountType: "User",
          suspended: false,
        },
      ],
    });
    mockedUpsertInstallation.mockResolvedValue(installationRow());

    const dtos = await syncInstallations(OWNER);

    expect(mockedUpsertInstallation).toHaveBeenCalledWith({
      installationId: INSTALLATION_ID,
      accountLogin: "octocat",
      accountType: "User",
      userId: USER_ID,
      suspendedAt: null,
    });
    expect(dtos).toHaveLength(1);
    expect(dtos[0]?.installationId).toBe("4242");
  });

  it("treats 'just installed, nothing synced yet' as an empty list, not an error (§9)", async () => {
    mockedFindToken.mockResolvedValue("gho_token");
    mockedListUserInstallations.mockResolvedValue({
      ok: true,
      installations: [],
    });

    await expect(syncInstallations(OWNER)).resolves.toEqual([]);
  });

  it("asks for a 401 re-auth when no GitHub OAuth token is stored", async () => {
    mockedFindToken.mockResolvedValue(null);

    await expect(syncInstallations(OWNER)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(mockedListUserInstallations).not.toHaveBeenCalled();
  });

  it("asks for a 401 re-auth when GitHub rejects the stored token", async () => {
    mockedFindToken.mockResolvedValue("stale");
    mockedListUserInstallations.mockResolvedValue({
      ok: false,
      reason: "UNAUTHENTICATED",
    });

    await expect(syncInstallations(OWNER)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("surfaces a GitHub outage as 503, not as a re-auth prompt", async () => {
    mockedFindToken.mockResolvedValue("gho_token");
    mockedListUserInstallations.mockResolvedValue({
      ok: false,
      reason: "UNAVAILABLE",
    });

    await expect(syncInstallations(OWNER)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });
});
