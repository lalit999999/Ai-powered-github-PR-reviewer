import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "./session.js";

// Mocked, not stubbed at the Prisma level: requireTenantAccess reads through the
// repository layer by design (Rule B / phase-01 §7), so the repository *is* the seam.
// Hoisted by vitest above the imports below, so the real module — and with it
// @repo/db's Prisma client, which needs DATABASE_URL at import time — is never loaded.
vi.mock("../../modules/projects/project.repository.js", () => ({
  findOwnershipById: vi.fn(),
}));
vi.mock("../../modules/repositories/repository.repository.js", () => ({
  findOwnershipById: vi.fn(),
}));
vi.mock("../../modules/pull-requests/pull-request.repository.js", () => ({
  findOwnershipById: vi.fn(),
}));
vi.mock("../../modules/reviews/review.repository.js", () => ({
  findOwnershipById: vi.fn(),
}));

// Captures the phase-01 §20 warn line without racing pino's stdout.
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

const { findOwnershipById } =
  await import("../../modules/projects/project.repository.js");
const repositoryRepository =
  await import("../../modules/repositories/repository.repository.js");
const pullRequestRepository = await import(
  "../../modules/pull-requests/pull-request.repository.js"
);
const reviewRepository =
  await import("../../modules/reviews/review.repository.js");
const { InternalError, NotFoundError } = await import("../errors.js");
const { requireTenantAccess } = await import("./tenant-access.js");
const { getTraceContext, runWithTraceContext } =
  await import("@repo/observability");

const OWNER_ID = "user-a";
const OTHER_ID = "user-b";
const PROJECT_ID = "project-1";
const OTHER_PROJECT_ID = "project-2";
const REPOSITORY_ID = "repo-1";
const PULL_REQUEST_ID = "pr-1";
const REVIEW_ID = "review-1";

function sessionFor(userId: string): AuthenticatedSession {
  return {
    user: { id: userId },
    expires: new Date(Date.now() + 60_000).toISOString(),
  } as AuthenticatedSession;
}

const mockedFindOwnershipById = vi.mocked(findOwnershipById);
const mockedFindRepositoryOwnership = vi.mocked(
  repositoryRepository.findOwnershipById,
);
const mockedFindPullRequestOwnership = vi.mocked(
  pullRequestRepository.findOwnershipById,
);
const mockedFindReviewOwnership = vi.mocked(reviewRepository.findOwnershipById);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireTenantAccess — the single authorization chokepoint (phase-01 §7/§13)", () => {
  it("returns a TenantContext for the project's owner", async () => {
    mockedFindOwnershipById.mockResolvedValue({
      id: PROJECT_ID,
      userId: OWNER_ID,
      deletedAt: null,
    });

    await expect(
      requireTenantAccess(sessionFor(OWNER_ID), { projectId: PROJECT_ID }),
    ).resolves.toEqual({
      userId: OWNER_ID,
      projectId: PROJECT_ID,
    });
    expect(logSpies.warn).not.toHaveBeenCalled();
  });

  it("resolves the ownership chain in a single query", async () => {
    mockedFindOwnershipById.mockResolvedValue({
      id: PROJECT_ID,
      userId: OWNER_ID,
      deletedAt: null,
    });

    await requireTenantAccess(sessionFor(OWNER_ID), { projectId: PROJECT_ID });

    // plan.md §34.2: "resolving the ownership chain in one query". A second read here
    // would be a per-request cost every authenticated route in the system pays.
    expect(mockedFindOwnershipById).toHaveBeenCalledTimes(1);
    expect(mockedFindOwnershipById).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("puts projectId in the trace context so later log lines carry it (phase-01 §16/§20)", async () => {
    mockedFindOwnershipById.mockResolvedValue({
      id: PROJECT_ID,
      userId: OWNER_ID,
      deletedAt: null,
    });

    await runWithTraceContext({ traceId: "trace-tenant" }, async () => {
      await requireTenantAccess(sessionFor(OWNER_ID), {
        projectId: PROJECT_ID,
      });
      expect(getTraceContext()).toMatchObject({
        traceId: "trace-tenant",
        projectId: PROJECT_ID,
      });
    });
  });
});

/**
 * The 404-for-everything policy. Phase-01 §7 lists 403 and 404 as separate outcomes
 * while §12 says both must render as 404, because a 403 reveals that a resource exists.
 * §12 wins (see requireTenantAccess's own doc comment) — these tests are what pins that
 * decision down so it cannot be quietly reverted.
 */
describe("requireTenantAccess — every failure is a caller-visible 404", () => {
  const cases = [
    {
      label: "a project owned by someone else",
      row: { id: PROJECT_ID, userId: OTHER_ID, deletedAt: null },
      reason: "FOREIGN",
    },
    {
      label: "a project that does not exist",
      row: null,
      reason: "MISSING",
    },
    {
      label: "a soft-deleted project",
      row: {
        id: PROJECT_ID,
        userId: OWNER_ID,
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      reason: "DELETED",
    },
  ] as const;

  for (const { label, row, reason } of cases) {
    it(`throws a 404 NotFoundError for ${label}`, async () => {
      mockedFindOwnershipById.mockResolvedValue(row);

      const promise = requireTenantAccess(sessionFor(OWNER_ID), {
        projectId: PROJECT_ID,
      });

      await expect(promise).rejects.toBeInstanceOf(NotFoundError);
      await expect(promise).rejects.toMatchObject({
        httpStatus: 404,
        code: "NOT_FOUND",
      });
    });

    it(`logs a warn line distinguishing ${label} internally as ${reason}`, async () => {
      mockedFindOwnershipById.mockResolvedValue(row);

      await expect(
        requireTenantAccess(sessionFor(OWNER_ID), { projectId: PROJECT_ID }),
      ).rejects.toThrow();

      // The distinction the caller is denied is preserved here, and only here.
      expect(logSpies.warn).toHaveBeenCalledWith("tenant access denied", {
        projectId: PROJECT_ID,
        userId: OWNER_ID,
        reason,
      });
    });
  }

  it("gives a foreign project the same 404 and message as a nonexistent one — no oracle", async () => {
    mockedFindOwnershipById.mockResolvedValueOnce({
      id: PROJECT_ID,
      userId: OTHER_ID,
      deletedAt: null,
    });
    const foreign = await requireTenantAccess(sessionFor(OWNER_ID), {
      projectId: PROJECT_ID,
    }).catch((e) => e);

    mockedFindOwnershipById.mockResolvedValueOnce(null);
    const missing = await requireTenantAccess(sessionFor(OWNER_ID), {
      projectId: PROJECT_ID,
    }).catch((e) => e);

    expect(foreign.toEnvelope()).toEqual(missing.toEnvelope());
    expect(foreign.httpStatus).toBe(missing.httpStatus);
  });

  it("never puts a denied projectId into the trace context", async () => {
    mockedFindOwnershipById.mockResolvedValue({
      id: PROJECT_ID,
      userId: OTHER_ID,
      deletedAt: null,
    });

    await runWithTraceContext({ traceId: "trace-denied" }, async () => {
      await expect(
        requireTenantAccess(sessionFor(OWNER_ID), { projectId: PROJECT_ID }),
      ).rejects.toThrow();
      expect(getTraceContext()?.projectId).toBeUndefined();
    });
  });
});

describe("requireTenantAccess — allowDeleted (what makes DELETE idempotent, phase-01 §4)", () => {
  it("resolves a soft-deleted project the caller owns", async () => {
    mockedFindOwnershipById.mockResolvedValue({
      id: PROJECT_ID,
      userId: OWNER_ID,
      deletedAt: new Date(),
    });

    await expect(
      requireTenantAccess(
        sessionFor(OWNER_ID),
        { projectId: PROJECT_ID },
        { allowDeleted: true },
      ),
    ).resolves.toEqual({ userId: OWNER_ID, projectId: PROJECT_ID });
  });

  it("still refuses a soft-deleted project owned by someone else", async () => {
    mockedFindOwnershipById.mockResolvedValue({
      id: PROJECT_ID,
      userId: OTHER_ID,
      deletedAt: new Date(),
    });

    await expect(
      requireTenantAccess(
        sessionFor(OWNER_ID),
        { projectId: PROJECT_ID },
        { allowDeleted: true },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(logSpies.warn).toHaveBeenCalledWith("tenant access denied", {
      projectId: PROJECT_ID,
      userId: OWNER_ID,
      reason: "FOREIGN",
    });
  });

  it("still refuses a nonexistent project", async () => {
    mockedFindOwnershipById.mockResolvedValue(null);

    await expect(
      requireTenantAccess(
        sessionFor(OWNER_ID),
        { projectId: PROJECT_ID },
        { allowDeleted: true },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("requireTenantAccess — misuse is a 500, not a silent pass", () => {
  it("throws InternalError when the resource names nothing resolvable", async () => {
    // A handler that forgot to pass an id must never end up with a TenantContext that
    // names no tenant — that would be a fail-open.
    await expect(
      requireTenantAccess(sessionFor(OWNER_ID), {}),
    ).rejects.toBeInstanceOf(InternalError);
    expect(mockedFindOwnershipById).not.toHaveBeenCalled();
  });
});

/**
 * Phase 02's extension. The point of these tests is that the *extension* did not
 * loosen anything: the same denial semantics, the same 404, the same "the reason lives
 * only in the log line" rule, now one link further up the ownership chain.
 */
describe("requireTenantAccess — repositoryId resolution (phase-02 §7)", () => {
  function repositoryOwnership(
    overrides: Partial<{
      userId: string;
      projectId: string;
      projectDeletedAt: Date | null;
    }> = {},
  ) {
    return {
      id: REPOSITORY_ID,
      projectId: PROJECT_ID,
      userId: OWNER_ID,
      projectDeletedAt: null,
      ...overrides,
    };
  }

  it("returns a context carrying BOTH ids — a repository always names its project", async () => {
    mockedFindRepositoryOwnership.mockResolvedValue(repositoryOwnership());

    await expect(
      requireTenantAccess(sessionFor(OWNER_ID), {
        repositoryId: REPOSITORY_ID,
      }),
    ).resolves.toEqual({
      userId: OWNER_ID,
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
    });
  });

  it("walks Repository -> Project -> userId in a single query", async () => {
    mockedFindRepositoryOwnership.mockResolvedValue(repositoryOwnership());

    await requireTenantAccess(sessionFor(OWNER_ID), {
      repositoryId: REPOSITORY_ID,
    });

    // plan.md §34.2 again: one query, not "read the repository, then read its project".
    expect(mockedFindRepositoryOwnership).toHaveBeenCalledTimes(1);
    expect(mockedFindRepositoryOwnership).toHaveBeenCalledWith(REPOSITORY_ID);
    expect(mockedFindOwnershipById).not.toHaveBeenCalled();
  });

  it("puts BOTH projectId and repositoryId in the trace context (phase-02 §20)", async () => {
    mockedFindRepositoryOwnership.mockResolvedValue(repositoryOwnership());

    await runWithTraceContext({ traceId: "trace-repo" }, async () => {
      await requireTenantAccess(sessionFor(OWNER_ID), {
        repositoryId: REPOSITORY_ID,
      });
      // The request-completion line is emitted after the handler returns and reads only
      // this context — so without both fields here, §20 does not hold for it.
      expect(getTraceContext()).toMatchObject({
        traceId: "trace-repo",
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
      });
    });
  });

  it("denies a foreign repository with a 404, not a 403", async () => {
    // phase-02 §7 lists 403 for this route. It is deliberately not followed: a
    // repository id is an opaque uuid, and a 403 would turn guessing into enumeration.
    // See requireTenantAccess's doc comment and docs/decisions/phase-02-log.md.
    mockedFindRepositoryOwnership.mockResolvedValue(
      repositoryOwnership({ userId: OTHER_ID }),
    );

    const promise = requireTenantAccess(sessionFor(OWNER_ID), {
      repositoryId: REPOSITORY_ID,
    });

    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
    await expect(promise).rejects.toMatchObject({
      httpStatus: 404,
      code: "NOT_FOUND",
    });
    expect(logSpies.warn).toHaveBeenCalledWith("tenant access denied", {
      projectId: PROJECT_ID,
      userId: OWNER_ID,
      reason: "FOREIGN",
      repositoryId: REPOSITORY_ID,
    });
  });

  it("denies a nonexistent repository as MISSING, with no project to name", async () => {
    mockedFindRepositoryOwnership.mockResolvedValue(null);

    await expect(
      requireTenantAccess(sessionFor(OWNER_ID), {
        repositoryId: REPOSITORY_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(logSpies.warn).toHaveBeenCalledWith("tenant access denied", {
      projectId: null,
      userId: OWNER_ID,
      reason: "MISSING",
      repositoryId: REPOSITORY_ID,
    });
  });

  it("denies a repository whose parent project is soft-deleted", async () => {
    mockedFindRepositoryOwnership.mockResolvedValue(
      repositoryOwnership({ projectDeletedAt: new Date() }),
    );

    await expect(
      requireTenantAccess(sessionFor(OWNER_ID), {
        repositoryId: REPOSITORY_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(logSpies.warn).toHaveBeenCalledWith(
      "tenant access denied",
      expect.objectContaining({
        reason: "DELETED",
        repositoryId: REPOSITORY_ID,
      }),
    );
  });

  it("gives a foreign repository the same envelope as a nonexistent one — no oracle", async () => {
    mockedFindRepositoryOwnership.mockResolvedValueOnce(
      repositoryOwnership({ userId: OTHER_ID }),
    );
    const foreign = await requireTenantAccess(sessionFor(OWNER_ID), {
      repositoryId: REPOSITORY_ID,
    }).catch((e) => e);

    mockedFindRepositoryOwnership.mockResolvedValueOnce(null);
    const missing = await requireTenantAccess(sessionFor(OWNER_ID), {
      repositoryId: REPOSITORY_ID,
    }).catch((e) => e);

    expect(foreign.toEnvelope()).toEqual(missing.toEnvelope());
    // Not even "Repository not found" — that would confirm the id names a repository.
    expect(foreign.message).toBe("Project not found");
  });

  it("never puts a denied repositoryId into the trace context", async () => {
    mockedFindRepositoryOwnership.mockResolvedValue(
      repositoryOwnership({ userId: OTHER_ID }),
    );

    await runWithTraceContext({ traceId: "trace-denied-repo" }, async () => {
      await expect(
        requireTenantAccess(sessionFor(OWNER_ID), {
          repositoryId: REPOSITORY_ID,
        }),
      ).rejects.toThrow();
      expect(getTraceContext()?.repositoryId).toBeUndefined();
      expect(getTraceContext()?.projectId).toBeUndefined();
    });
  });
});

describe("requireTenantAccess — projectId AND repositoryId together", () => {
  it("resolves when the repository really is under the named project", async () => {
    mockedFindRepositoryOwnership.mockResolvedValue({
      id: REPOSITORY_ID,
      projectId: PROJECT_ID,
      userId: OWNER_ID,
      projectDeletedAt: null,
    });

    await expect(
      requireTenantAccess(sessionFor(OWNER_ID), {
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
      }),
    ).resolves.toEqual({
      userId: OWNER_ID,
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
    });
  });

  it("denies a mismatch rather than silently preferring one of the two", async () => {
    // The caller owns both projects here, so this is not an ownership failure — it is
    // the two ids disagreeing. Trusting the repository's own projectId would let a
    // handler operate on a project the request did not name.
    mockedFindRepositoryOwnership.mockResolvedValue({
      id: REPOSITORY_ID,
      projectId: OTHER_PROJECT_ID,
      userId: OWNER_ID,
      projectDeletedAt: null,
    });

    const promise = requireTenantAccess(sessionFor(OWNER_ID), {
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
    });

    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
    expect(logSpies.warn).toHaveBeenCalledWith("tenant access denied", {
      // The *attempted* project, not the real one: the real one is not the caller's
      // business, and the attempted one is what a probing pattern looks like.
      projectId: PROJECT_ID,
      userId: OWNER_ID,
      reason: "MISMATCH",
      repositoryId: REPOSITORY_ID,
    });
  });
});

describe("requireTenantAccess — the project-only path is unchanged by the extension", () => {
  it("never consults the repository layer when no repositoryId was asked for", async () => {
    mockedFindOwnershipById.mockResolvedValue({
      id: PROJECT_ID,
      userId: OWNER_ID,
      deletedAt: null,
    });

    await requireTenantAccess(sessionFor(OWNER_ID), { projectId: PROJECT_ID });

    expect(mockedFindRepositoryOwnership).not.toHaveBeenCalled();
  });

  it("emits the phase-01 warn line byte-for-byte, with no repositoryId key", async () => {
    // Existing log queries filter on this exact shape; adding a key would break them.
    mockedFindOwnershipById.mockResolvedValue(null);

    await expect(
      requireTenantAccess(sessionFor(OWNER_ID), { projectId: PROJECT_ID }),
    ).rejects.toThrow();

    expect(logSpies.warn).toHaveBeenCalledWith("tenant access denied", {
      projectId: PROJECT_ID,
      userId: OWNER_ID,
      reason: "MISSING",
    });
  });
});

/**
 * Phase 07 sub-task 1.5's extension. Same discipline the phase-02 repositoryId section
 * above already pins down: the extension does not loosen anything — same 404, same
 * "the reason lives only in the log line" rule, one link further up the chain.
 */
describe("requireTenantAccess — pullRequestId resolution (phase-07 sub-task 1.5)", () => {
  function pullRequestOwnership(
    overrides: Partial<{
      userId: string;
      projectId: string;
      repositoryId: string;
      projectDeletedAt: Date | null;
    }> = {},
  ) {
    return {
      id: PULL_REQUEST_ID,
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      userId: OWNER_ID,
      projectDeletedAt: null,
      ...overrides,
    };
  }

  it("returns a context carrying projectId, repositoryId, AND pullRequestId", async () => {
    mockedFindPullRequestOwnership.mockResolvedValue(pullRequestOwnership());

    await expect(
      requireTenantAccess(sessionFor(OWNER_ID), {
        pullRequestId: PULL_REQUEST_ID,
      }),
    ).resolves.toEqual({
      userId: OWNER_ID,
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      pullRequestId: PULL_REQUEST_ID,
    });
  });

  it("walks PullRequest -> Repository -> Project -> userId in a single query", async () => {
    mockedFindPullRequestOwnership.mockResolvedValue(pullRequestOwnership());

    await requireTenantAccess(sessionFor(OWNER_ID), {
      pullRequestId: PULL_REQUEST_ID,
    });

    expect(mockedFindPullRequestOwnership).toHaveBeenCalledTimes(1);
    expect(mockedFindPullRequestOwnership).toHaveBeenCalledWith(
      PULL_REQUEST_ID,
    );
    expect(mockedFindRepositoryOwnership).not.toHaveBeenCalled();
    expect(mockedFindOwnershipById).not.toHaveBeenCalled();
  });

  it("puts projectId AND repositoryId in the trace context", async () => {
    mockedFindPullRequestOwnership.mockResolvedValue(pullRequestOwnership());

    await runWithTraceContext({ traceId: "trace-pr" }, async () => {
      await requireTenantAccess(sessionFor(OWNER_ID), {
        pullRequestId: PULL_REQUEST_ID,
      });
      expect(getTraceContext()).toMatchObject({
        traceId: "trace-pr",
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
      });
    });
  });

  it("denies a foreign pull request with a 404, not a 403", async () => {
    mockedFindPullRequestOwnership.mockResolvedValue(
      pullRequestOwnership({ userId: OTHER_ID }),
    );

    const promise = requireTenantAccess(sessionFor(OWNER_ID), {
      pullRequestId: PULL_REQUEST_ID,
    });

    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
    expect(logSpies.warn).toHaveBeenCalledWith("tenant access denied", {
      projectId: PROJECT_ID,
      userId: OWNER_ID,
      reason: "FOREIGN",
      pullRequestId: PULL_REQUEST_ID,
    });
  });

  it("denies a nonexistent pull request as MISSING, with no project to name", async () => {
    mockedFindPullRequestOwnership.mockResolvedValue(null);

    await expect(
      requireTenantAccess(sessionFor(OWNER_ID), {
        pullRequestId: PULL_REQUEST_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(logSpies.warn).toHaveBeenCalledWith("tenant access denied", {
      projectId: null,
      userId: OWNER_ID,
      reason: "MISSING",
      pullRequestId: PULL_REQUEST_ID,
    });
  });

  it("denies a pull request whose parent project is soft-deleted", async () => {
    mockedFindPullRequestOwnership.mockResolvedValue(
      pullRequestOwnership({ projectDeletedAt: new Date() }),
    );

    await expect(
      requireTenantAccess(sessionFor(OWNER_ID), {
        pullRequestId: PULL_REQUEST_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(logSpies.warn).toHaveBeenCalledWith(
      "tenant access denied",
      expect.objectContaining({
        reason: "DELETED",
        pullRequestId: PULL_REQUEST_ID,
      }),
    );
  });

  it("denies a mismatch when the caller's projectId disagrees with the resolved chain", async () => {
    mockedFindPullRequestOwnership.mockResolvedValue(pullRequestOwnership());

    const promise = requireTenantAccess(sessionFor(OWNER_ID), {
      projectId: OTHER_PROJECT_ID,
      pullRequestId: PULL_REQUEST_ID,
    });

    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
    expect(logSpies.warn).toHaveBeenCalledWith("tenant access denied", {
      // The *attempted* project, not the real one.
      projectId: OTHER_PROJECT_ID,
      userId: OWNER_ID,
      reason: "MISMATCH",
      pullRequestId: PULL_REQUEST_ID,
    });
  });

  it("gives a foreign pull request the same envelope as a nonexistent one — no oracle", async () => {
    mockedFindPullRequestOwnership.mockResolvedValueOnce(
      pullRequestOwnership({ userId: OTHER_ID }),
    );
    const foreign = await requireTenantAccess(sessionFor(OWNER_ID), {
      pullRequestId: PULL_REQUEST_ID,
    }).catch((e) => e);

    mockedFindPullRequestOwnership.mockResolvedValueOnce(null);
    const missing = await requireTenantAccess(sessionFor(OWNER_ID), {
      pullRequestId: PULL_REQUEST_ID,
    }).catch((e) => e);

    expect(foreign.toEnvelope()).toEqual(missing.toEnvelope());
    expect(foreign.message).toBe("Project not found");
  });
});

describe("requireTenantAccess — reviewId resolution (phase-07 sub-task 1.5)", () => {
  function reviewOwnership(
    overrides: Partial<{
      userId: string;
      projectId: string;
      repositoryId: string;
      pullRequestId: string;
      projectDeletedAt: Date | null;
    }> = {},
  ) {
    return {
      id: REVIEW_ID,
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      pullRequestId: PULL_REQUEST_ID,
      userId: OWNER_ID,
      projectDeletedAt: null,
      ...overrides,
    };
  }

  it("returns a context carrying all four ids — a review resolves the whole chain", async () => {
    mockedFindReviewOwnership.mockResolvedValue(reviewOwnership());

    await expect(
      requireTenantAccess(sessionFor(OWNER_ID), { reviewId: REVIEW_ID }),
    ).resolves.toEqual({
      userId: OWNER_ID,
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      pullRequestId: PULL_REQUEST_ID,
      reviewId: REVIEW_ID,
    });
  });

  it("walks Review -> PullRequest -> Repository -> Project -> userId in a single query", async () => {
    mockedFindReviewOwnership.mockResolvedValue(reviewOwnership());

    await requireTenantAccess(sessionFor(OWNER_ID), { reviewId: REVIEW_ID });

    expect(mockedFindReviewOwnership).toHaveBeenCalledTimes(1);
    expect(mockedFindReviewOwnership).toHaveBeenCalledWith(REVIEW_ID);
    expect(mockedFindPullRequestOwnership).not.toHaveBeenCalled();
    expect(mockedFindRepositoryOwnership).not.toHaveBeenCalled();
    expect(mockedFindOwnershipById).not.toHaveBeenCalled();
  });

  it("denies a foreign review with a 404, not a 403", async () => {
    mockedFindReviewOwnership.mockResolvedValue(
      reviewOwnership({ userId: OTHER_ID }),
    );

    const promise = requireTenantAccess(sessionFor(OWNER_ID), {
      reviewId: REVIEW_ID,
    });

    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
    expect(logSpies.warn).toHaveBeenCalledWith("tenant access denied", {
      projectId: PROJECT_ID,
      userId: OWNER_ID,
      reason: "FOREIGN",
      reviewId: REVIEW_ID,
    });
  });

  it("denies a nonexistent review as MISSING, with no project to name", async () => {
    mockedFindReviewOwnership.mockResolvedValue(null);

    await expect(
      requireTenantAccess(sessionFor(OWNER_ID), { reviewId: REVIEW_ID }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(logSpies.warn).toHaveBeenCalledWith("tenant access denied", {
      projectId: null,
      userId: OWNER_ID,
      reason: "MISSING",
      reviewId: REVIEW_ID,
    });
  });

  it("denies a review whose parent project is soft-deleted", async () => {
    mockedFindReviewOwnership.mockResolvedValue(
      reviewOwnership({ projectDeletedAt: new Date() }),
    );

    await expect(
      requireTenantAccess(sessionFor(OWNER_ID), { reviewId: REVIEW_ID }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(logSpies.warn).toHaveBeenCalledWith(
      "tenant access denied",
      expect.objectContaining({ reason: "DELETED", reviewId: REVIEW_ID }),
    );
  });

  // The MISMATCH case sub-task 1.5 names explicitly: caller supplies both a projectId
  // and a reviewId under a different project.
  it("denies a mismatch when the caller supplies a projectId under a different project than the review resolves to", async () => {
    mockedFindReviewOwnership.mockResolvedValue(reviewOwnership());

    const promise = requireTenantAccess(sessionFor(OWNER_ID), {
      projectId: OTHER_PROJECT_ID,
      reviewId: REVIEW_ID,
    });

    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
    expect(logSpies.warn).toHaveBeenCalledWith("tenant access denied", {
      projectId: OTHER_PROJECT_ID,
      userId: OWNER_ID,
      reason: "MISMATCH",
      reviewId: REVIEW_ID,
    });
  });

  it("denies a mismatch when the caller's pullRequestId disagrees with the resolved chain", async () => {
    mockedFindReviewOwnership.mockResolvedValue(reviewOwnership());

    const promise = requireTenantAccess(sessionFor(OWNER_ID), {
      pullRequestId: "some-other-pr",
      reviewId: REVIEW_ID,
    });

    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
    expect(logSpies.warn).toHaveBeenCalledWith("tenant access denied", {
      projectId: PROJECT_ID,
      userId: OWNER_ID,
      reason: "MISMATCH",
      pullRequestId: "some-other-pr",
      reviewId: REVIEW_ID,
    });
  });

  it("gives a foreign review the same envelope as a nonexistent one — no oracle", async () => {
    mockedFindReviewOwnership.mockResolvedValueOnce(
      reviewOwnership({ userId: OTHER_ID }),
    );
    const foreign = await requireTenantAccess(sessionFor(OWNER_ID), {
      reviewId: REVIEW_ID,
    }).catch((e) => e);

    mockedFindReviewOwnership.mockResolvedValueOnce(null);
    const missing = await requireTenantAccess(sessionFor(OWNER_ID), {
      reviewId: REVIEW_ID,
    }).catch((e) => e);

    expect(foreign.toEnvelope()).toEqual(missing.toEnvelope());
    expect(foreign.message).toBe("Project not found");
  });

  it("reviewId takes priority over a pullRequestId supplied alongside it — resolves the review path, not the pull-request path", async () => {
    mockedFindReviewOwnership.mockResolvedValue(reviewOwnership());

    await requireTenantAccess(sessionFor(OWNER_ID), {
      pullRequestId: PULL_REQUEST_ID,
      reviewId: REVIEW_ID,
    });

    expect(mockedFindReviewOwnership).toHaveBeenCalledTimes(1);
    expect(mockedFindPullRequestOwnership).not.toHaveBeenCalled();
  });
});
