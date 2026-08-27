import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/core";
import { classifyGithubError } from "./github-result.js";
import {
  MAX_PAGES,
  listInstallationRepositories,
  listUserInstallations,
} from "./installation.github.js";
import { getHeadCommit, getRepository } from "./repository.github.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const INSTALLATION_ID = 4242n;

/** A stub standing in for the one method these wrappers use. Cast at the boundary so
 * the tests never have to construct a real Octokit (which would need a token, a
 * private key, and a socket). */
function stubOctokit(
  request: (route: string, params?: Record<string, unknown>) => unknown,
): Octokit {
  return { request: vi.fn(request) } as unknown as Octokit;
}

/** Shapes the error Octokit throws: a status plus (optionally) response headers. */
function githubError(
  status: number,
  headers?: Record<string, string>,
): Error & { status: number } {
  const error = new Error(`HTTP ${status}`) as Error & {
    status: number;
    response?: unknown;
  };
  error.status = status;
  if (headers) error.response = { headers };
  return error;
}

function rawRepo(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `repo-${id}`,
    full_name: `octocat/repo-${id}`,
    private: true,
    default_branch: "main",
    owner: { login: "octocat" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("classifyGithubError — 404 means 'cannot see it', which is not the same as 403 (§12)", () => {
  it("maps 404 to NOT_ACCESSIBLE", () => {
    // GitHub deliberately answers 404 rather than 403 for a repository an installation
    // cannot see, as an anti-enumeration measure. The two cases are indistinguishable
    // on the wire, so the wrapper must not pretend otherwise.
    expect(classifyGithubError(githubError(404))).toBe("NOT_ACCESSIBLE");
  });

  it("maps a 403 with NO rate-limit headers to NOT_ACCESSIBLE", () => {
    expect(classifyGithubError(githubError(403))).toBe("NOT_ACCESSIBLE");
  });

  it("maps a 403 WITH rate-limit headers to UNAVAILABLE, never to a permission answer", () => {
    // Telling a user "the App doesn't have access" because GitHub was busy would send
    // them to reconfigure an installation that is working fine (§12/§14).
    expect(
      classifyGithubError(githubError(403, { "x-ratelimit-remaining": "0" })),
    ).toBe("UNAVAILABLE");
    expect(classifyGithubError(githubError(429, { "retry-after": "60" }))).toBe(
      "UNAVAILABLE",
    );
  });

  it("maps 401 to UNAUTHENTICATED and 5xx/unknown to UNAVAILABLE", () => {
    expect(classifyGithubError(githubError(401))).toBe("UNAUTHENTICATED");
    expect(classifyGithubError(githubError(500))).toBe("UNAVAILABLE");
    expect(classifyGithubError(new Error("network down"))).toBe("UNAVAILABLE");
  });
});

describe("listInstallationRepositories — pagination past 100 (§9)", () => {
  it("keeps paging until a short page, rather than stopping at the first 100", async () => {
    // The bug this guards: an installation with 150 repositories silently showing 100
    // in the picker, which looks like a permissions problem rather than a paging one.
    const pages: Record<number, unknown[]> = {
      1: Array.from({ length: 100 }, (_, i) => rawRepo(i + 1)),
      2: Array.from({ length: 50 }, (_, i) => rawRepo(i + 101)),
    };
    const octokit = stubOctokit((_route, params) => ({
      data: {
        total_count: 150,
        repositories: pages[Number(params?.page)] ?? [],
      },
    }));

    const result = await listInstallationRepositories(INSTALLATION_ID, {
      octokit,
      logger,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.repositories).toHaveLength(150);
    expect(result.ok && result.repositories[149]?.githubRepoId).toBe(150n);
    expect(octokit.request).toHaveBeenCalledTimes(2);
  });

  it("stops after one request when the first page is short", async () => {
    const octokit = stubOctokit(() => ({
      data: { total_count: 2, repositories: [rawRepo(1), rawRepo(2)] },
    }));

    const result = await listInstallationRepositories(INSTALLATION_ID, {
      octokit,
      logger,
    });

    expect(result.ok && result.repositories).toHaveLength(2);
    expect(octokit.request).toHaveBeenCalledTimes(1);
  });

  it("does not trust total_count as the terminator", async () => {
    // total_count counts what the installation is entitled to, which is not always
    // what this listing returns; trusting it either truncates or loops forever.
    const octokit = stubOctokit((_route, params) =>
      Number(params?.page) === 1
        ? {
            data: {
              total_count: 0,
              repositories: Array.from({ length: 100 }, (_, i) =>
                rawRepo(i + 1),
              ),
            },
          }
        : { data: { total_count: 0, repositories: [rawRepo(101)] } },
    );

    const result = await listInstallationRepositories(INSTALLATION_ID, {
      octokit,
      logger,
    });

    expect(result.ok && result.repositories).toHaveLength(101);
  });

  it("cannot loop forever on an endpoint that never returns a short page", async () => {
    const octokit = stubOctokit(() => ({
      data: {
        repositories: Array.from({ length: 100 }, (_, i) => rawRepo(i + 1)),
      },
    }));

    const result = await listInstallationRepositories(INSTALLATION_ID, {
      octokit,
      logger,
    });

    expect(result.ok).toBe(true);
    expect(octokit.request).toHaveBeenCalledTimes(MAX_PAGES);
  });

  it("requests the full 100 per page rather than burning round trips", async () => {
    const octokit = stubOctokit(() => ({ data: { repositories: [] } }));

    await listInstallationRepositories(INSTALLATION_ID, { octokit, logger });

    expect(octokit.request).toHaveBeenCalledWith(
      "GET /installation/repositories",
      { per_page: 100, page: 1 },
    );
  });

  it("keeps a repository with no default branch — emptiness is the validator's call", async () => {
    const octokit = stubOctokit(() => ({
      data: { repositories: [rawRepo(7, { default_branch: null })] },
    }));

    const result = await listInstallationRepositories(INSTALLATION_ID, {
      octokit,
      logger,
    });

    expect(result.ok && result.repositories[0]?.defaultBranch).toBe("");
  });

  it("drops an entry GitHub described without an id or owner", async () => {
    const octokit = stubOctokit(() => ({
      data: {
        repositories: [
          rawRepo(1),
          { name: "no-id", owner: { login: "octocat" } },
          { id: 3 },
        ],
      },
    }));

    const result = await listInstallationRepositories(INSTALLATION_ID, {
      octokit,
      logger,
    });

    expect(result.ok && result.repositories.map((r) => r.githubRepoId)).toEqual(
      [1n],
    );
  });

  it("returns a typed failure instead of throwing", async () => {
    const octokit = stubOctokit(() => {
      throw githubError(500);
    });

    await expect(
      listInstallationRepositories(INSTALLATION_ID, { octokit, logger }),
    ).resolves.toEqual({
      ok: false,
      reason: "UNAVAILABLE",
    });
  });
});

describe("listUserInstallations — the one call using the USER's OAuth token (§9)", () => {
  it("paginates and maps GitHub's installation shape", async () => {
    const octokit = stubOctokit((_route, params) =>
      Number(params?.page) === 1
        ? {
            data: {
              installations: Array.from({ length: 100 }, (_, i) => ({
                id: i + 1,
                account: { login: `acct-${i + 1}`, type: "Organization" },
              })),
            },
          }
        : {
            data: {
              installations: [
                {
                  id: 101,
                  account: { login: "acct-101", type: "User" },
                  suspended_at: "x",
                },
              ],
            },
          },
    );

    const result = await listUserInstallations("gho_token", {
      octokit,
      logger,
    });

    expect(result.ok && result.installations).toHaveLength(101);
    expect(result.ok && result.installations[100]).toEqual({
      installationId: 101n,
      accountLogin: "acct-101",
      accountType: "User",
      suspended: true,
    });
  });

  it("treats 'user has installed nothing' as an ordinary empty result, not an error", async () => {
    // phase-02 §9's "installation not yet synced (user just installed)" case.
    const octokit = stubOctokit(() => ({
      data: { total_count: 0, installations: [] },
    }));

    await expect(
      listUserInstallations("gho_token", { octokit, logger }),
    ).resolves.toEqual({
      ok: true,
      installations: [],
    });
  });

  it("reports a rejected OAuth token as UNAUTHENTICATED, distinct from a missing App", async () => {
    const octokit = stubOctokit(() => {
      throw githubError(401);
    });

    await expect(
      listUserInstallations("stale", { octokit, logger }),
    ).resolves.toEqual({
      ok: false,
      reason: "UNAUTHENTICATED",
    });
  });
});

describe("getRepository — one fetch per connect attempt (§21)", () => {
  it("maps the metadata the validation chain needs", async () => {
    const octokit = stubOctokit(() => ({
      data: rawRepo(1296269, {
        full_name: "octocat/Hello-World",
        name: "Hello-World",
        size: 108,
        html_url: "https://github.com/octocat/Hello-World",
        private: false,
      }),
    }));

    const result = await getRepository(
      INSTALLATION_ID,
      "octocat",
      "hello-world",
      { octokit, logger },
    );

    expect(result).toEqual({
      ok: true,
      repository: {
        githubRepoId: 1296269n,
        owner: "octocat",
        name: "Hello-World",
        fullName: "octocat/Hello-World",
        defaultBranch: "main",
        isPrivate: false,
        htmlUrl: "https://github.com/octocat/Hello-World",
        sizeKib: 108,
        archived: false,
        disabled: false,
      },
    });
  });

  it("issues exactly one request — the §21 cost lever", async () => {
    // The structural half of this guarantee is that repository-validation.service
    // takes metadata as an argument and has no way to fetch any; this is the other
    // half, asserted at the source.
    const octokit = stubOctokit(() => ({ data: rawRepo(1) }));

    await getRepository(INSTALLATION_ID, "octocat", "hello-world", {
      octokit,
      logger,
    });

    expect(octokit.request).toHaveBeenCalledTimes(1);
    expect(octokit.request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}", {
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("returns NOT_ACCESSIBLE for a 404 rather than inventing a 'not found' it cannot prove", async () => {
    const octokit = stubOctokit(() => {
      throw githubError(404);
    });

    await expect(
      getRepository(INSTALLATION_ID, "octocat", "secret", { octokit, logger }),
    ).resolves.toEqual({
      ok: false,
      reason: "NOT_ACCESSIBLE",
    });
  });

  it("normalizes a missing default_branch to null so 'empty' is checkable", async () => {
    const octokit = stubOctokit(() => ({
      data: rawRepo(1, { default_branch: "", size: 0 }),
    }));

    const result = await getRepository(
      INSTALLATION_ID,
      "octocat",
      "brand-new",
      { octokit, logger },
    );

    expect(result.ok && result.repository.defaultBranch).toBeNull();
    expect(result.ok && result.repository.sizeKib).toBe(0);
  });

  it("reports a body it does not understand as UNAVAILABLE, not as a permission answer", async () => {
    const octokit = stubOctokit(() => ({
      data: { message: "something else entirely" },
    }));

    await expect(
      getRepository(INSTALLATION_ID, "octocat", "hello-world", {
        octokit,
        logger,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "UNAVAILABLE",
    });
  });

  it("logs installationId on every outcome (§20)", async () => {
    const octokit = stubOctokit(() => ({ data: rawRepo(1) }));

    await getRepository(INSTALLATION_ID, "octocat", "hello-world", {
      octokit,
      logger,
    });

    expect(logger.info).toHaveBeenCalledWith(
      "fetched repository metadata",
      expect.objectContaining({ installationId: "4242" }),
    );
  });
});

describe("getHeadCommit — phase-03 §8 step 2, the second of exactly two GitHub calls per index", () => {
  it("resolves a branch to its head SHA", async () => {
    const octokit = stubOctokit(() => ({ data: { sha: "abc123def456" } }));

    const result = await getHeadCommit(
      INSTALLATION_ID,
      "octocat",
      "hello-world",
      "main",
      { octokit, logger },
    );

    expect(result).toEqual({ ok: true, commit: { sha: "abc123def456" } });
  });

  it("issues exactly one request against the branch ref", async () => {
    const octokit = stubOctokit(() => ({ data: { sha: "abc123" } }));

    await getHeadCommit(INSTALLATION_ID, "octocat", "hello-world", "main", {
      octokit,
      logger,
    });

    expect(octokit.request).toHaveBeenCalledTimes(1);
    expect(octokit.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/commits/{ref}",
      {
        owner: "octocat",
        repo: "hello-world",
        ref: "main",
      },
    );
  });

  it("returns NOT_ACCESSIBLE for a 404 — the branch is gone even though the repo metadata call already succeeded", async () => {
    const octokit = stubOctokit(() => {
      throw githubError(404);
    });

    await expect(
      getHeadCommit(
        INSTALLATION_ID,
        "octocat",
        "hello-world",
        "deleted-branch",
        { octokit, logger },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "NOT_ACCESSIBLE",
    });
  });

  it("reports a body it does not understand (missing/empty sha) as UNAVAILABLE", async () => {
    const octokit = stubOctokit(() => ({
      data: { message: "something else entirely" },
    }));

    await expect(
      getHeadCommit(INSTALLATION_ID, "octocat", "hello-world", "main", {
        octokit,
        logger,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "UNAVAILABLE",
    });

    const emptySha = stubOctokit(() => ({ data: { sha: "" } }));
    await expect(
      getHeadCommit(INSTALLATION_ID, "octocat", "hello-world", "main", {
        octokit: emptySha,
        logger,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "UNAVAILABLE",
    });
  });

  it("logs installationId and the resolved sha on success (§20)", async () => {
    const octokit = stubOctokit(() => ({ data: { sha: "deadbeef" } }));

    await getHeadCommit(INSTALLATION_ID, "octocat", "hello-world", "main", {
      octokit,
      logger,
    });

    expect(logger.info).toHaveBeenCalledWith(
      "resolved branch head commit",
      expect.objectContaining({ installationId: "4242", sha: "deadbeef" }),
    );
  });
});
