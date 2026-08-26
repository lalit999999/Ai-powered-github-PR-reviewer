import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubRepositoryMetadata } from "@repo/github";
import type { RepositoryRecord } from "./repository.types.js";

const logSpies = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock("@repo/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/observability")>();
  return { ...actual, createLogger: () => logSpies };
});

const {
  ConflictError,
  ForbiddenError,
  ServiceUnavailableError,
  UnprocessableEntityError,
  ValidationError,
} = await import("../../lib/errors.js");
const {
  DEFAULT_BRANCH_MESSAGE,
  EMPTY_REPOSITORY_MESSAGE,
  NO_ACCESS_MESSAGE,
  REPOSITORY_SIZE_CAP_KIB,
  assertNotAlreadyConnected,
  assertRepositoryAccessible,
  assertRepositoryUsable,
  isEmptyRepository,
  resolveRepoRefFromUrl,
} = await import("./repository-validation.service.js");

const CONTEXT = { projectId: "project-1", userId: "user-a" };

function metadata(overrides: Partial<GithubRepositoryMetadata> = {}): GithubRepositoryMetadata {
  return {
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
    ...overrides,
  };
}

/** A probe that fails the test if it is ever called. The happy path must never pay for
 * the ambiguity-breaking call (§21). */
const neverProbe = vi.fn(async () => {
  throw new Error("probeDefaultBranch must not be called on the happy path");
});

const usabilityContext = (probe = neverProbe) => ({ ...CONTEXT, probeDefaultBranch: probe });

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * phase-02 §4: "Each validation failure surfaces its own distinct, actionable error
 * message — not a generic 'connection failed'." §15 turns that into an acceptance
 * criterion. Each block below pins one step of §3's chain to one status, one code, and
 * one message.
 */

describe("step 1 — the URL parses (400)", () => {
  it("returns the owner/repo pair for a valid URL", () => {
    expect(resolveRepoRefFromUrl("https://github.com/octocat/Hello-World.git")).toEqual({
      owner: "octocat",
      repo: "Hello-World",
    });
  });

  it("rejects a non-GitHub host with a 400 and the actionable message", () => {
    const thrown = (() => {
      try {
        resolveRepoRefFromUrl("https://github.com.evil.com/o/r");
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(ValidationError);
    expect(thrown).toMatchObject({ httpStatus: 400, code: "VALIDATION_ERROR" });
    expect((thrown as Error).message).toMatch(/doesn't look like a GitHub repository URL/i);
  });

  it("re-checks the URL even though the HTTP schema already did", () => {
    // This service is callable from places that are not an HTTP request; a chain whose
    // first step assumes someone else ran it is not a chain.
    expect(() => resolveRepoRefFromUrl("http://github.com/o/r")).toThrow(ValidationError);
  });
});

describe("step 2 — the installation has access (403)", () => {
  const ctx = { ...CONTEXT, target: "octocat/secret" };

  it("unwraps the metadata on success", () => {
    expect(assertRepositoryAccessible({ ok: true, repository: metadata() }, ctx)).toEqual(metadata());
  });

  it("turns NOT_ACCESSIBLE into a 403 with the installation-settings message", () => {
    // Deliberately 403 and not 404: the caller already owns the project and named this
    // repository themselves, so nothing is revealed. See the service's doc comment.
    const thrown = (() => {
      try {
        assertRepositoryAccessible({ ok: false, reason: "NOT_ACCESSIBLE" }, ctx);
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(ForbiddenError);
    expect(thrown).toMatchObject({ httpStatus: 403, code: "FORBIDDEN" });
    expect((thrown as Error).message).toBe(NO_ACCESS_MESSAGE);
  });

  it("turns UNAVAILABLE into a 503, never into a permission answer", () => {
    // Telling a user to reconfigure a working installation because GitHub had a bad
    // minute sends them to fix something that is not broken (§12/§14).
    const thrown = (() => {
      try {
        assertRepositoryAccessible({ ok: false, reason: "UNAVAILABLE" }, ctx);
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(ServiceUnavailableError);
    expect(thrown).toMatchObject({ httpStatus: 503 });
    expect((thrown as Error).message).not.toBe(NO_ACCESS_MESSAGE);
  });
});

describe("step 3 — already connected to THIS project (409)", () => {
  function repositoryRow(overrides: Partial<RepositoryRecord> = {}): RepositoryRecord {
    return {
      id: "repo-1",
      projectId: "project-1",
      installationId: 42n,
      githubRepoId: 1296269n,
      owner: "octocat",
      name: "Hello-World",
      fullName: "octocat/Hello-World",
      defaultBranch: "main",
      isPrivate: false,
      htmlUrl: "https://github.com/octocat/Hello-World",
      sizeBytes: null,
      connectionStatus: "ACTIVE",
      indexStatus: "PENDING",
      indexedCommitSha: null,
      indexVersion: 1,
      indexedFileCount: 0,
      skippedFileCount: 0,
      lastIndexedAt: null,
      indexError: null,
      settings: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  const ctx = { ...CONTEXT, githubRepoId: 1296269n };

  it("passes when nothing is connected", () => {
    expect(() => assertNotAlreadyConnected(null, ctx)).not.toThrow();
  });

  it("rejects an existing connection with a 409", () => {
    const thrown = (() => {
      try {
        assertNotAlreadyConnected(repositoryRow(), ctx);
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(ConflictError);
    expect(thrown).toMatchObject({ httpStatus: 409, code: "CONFLICT" });
  });

  it("also rejects a DISCONNECTED row, because the unique constraint still holds it", () => {
    // A pre-check that ignored disconnected rows would propose an insert the database
    // then rejects — the constraint has no connectionStatus in it.
    expect(() => assertNotAlreadyConnected(repositoryRow({ connectionStatus: "DISCONNECTED" }), ctx)).toThrow(
      ConflictError,
    );
  });

  /**
   * §15's explicit acceptance criterion, and plan.md §45's named Phase 2 failure mode
   * ("assuming githubRepoId is globally unique"). This test fails the moment someone
   * "helpfully" adds a global uniqueness check.
   */
  it("treats the SAME repository under a DIFFERENT project as no conflict at all", () => {
    // The caller looked up by (projectId, githubRepoId), so the other project's row is
    // simply not found — and this function has no seam through which it could look for
    // one.
    expect(() => assertNotAlreadyConnected(null, { ...ctx, projectId: "project-2" })).not.toThrow();
  });
});

describe("step 4 — the repository is non-empty (422)", () => {
  it("does not probe at all when the repository has content", async () => {
    await expect(assertRepositoryUsable(metadata({ sizeKib: 108 }), usabilityContext())).resolves.toBeUndefined();
    expect(neverProbe).not.toHaveBeenCalled();
  });

  it("rejects size 0 with no default branch as unambiguously empty, without a probe", async () => {
    const promise = assertRepositoryUsable(
      metadata({ sizeKib: 0, defaultBranch: null }),
      usabilityContext(),
    );

    await expect(promise).rejects.toBeInstanceOf(UnprocessableEntityError);
    await expect(promise).rejects.toMatchObject({ httpStatus: 422, code: "UNPROCESSABLE_ENTITY" });
    await expect(promise).rejects.toThrow(EMPTY_REPOSITORY_MESSAGE);
    expect(neverProbe).not.toHaveBeenCalled();
  });

  it("probes when size 0 is ambiguous, and rejects only when the branch has no commits", async () => {
    const probe = vi.fn(async () => "EMPTY" as const);

    await expect(
      assertRepositoryUsable(metadata({ sizeKib: 0, defaultBranch: "main" }), usabilityContext(probe)),
    ).rejects.toThrow(EMPTY_REPOSITORY_MESSAGE);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("ACCEPTS a freshly pushed repository whose size GitHub has not computed yet", async () => {
    // The failure this guards: GitHub computes `size` asynchronously, so a repo pushed
    // seconds ago reports 0 while holding real commits. Rejecting on size alone would
    // tell that user their repository is empty.
    const probe = vi.fn(async () => "HAS_COMMITS" as const);

    await expect(
      assertRepositoryUsable(metadata({ sizeKib: 0, defaultBranch: "main" }), usabilityContext(probe)),
    ).resolves.toBeUndefined();
  });

  it("treats an UNKNOWN probe as non-empty rather than failing a good connect", async () => {
    // A transient GitHub 5xx must not become "your repository is empty".
    const probe = vi.fn(async () => "UNKNOWN" as const);

    await expect(isEmptyRepository(metadata({ sizeKib: 0, defaultBranch: "main" }), probe)).resolves.toBe(false);
  });
});

describe("step 5 — the size cap (422)", () => {
  it("accepts a repository exactly at the cap", async () => {
    await expect(
      assertRepositoryUsable(metadata({ sizeKib: REPOSITORY_SIZE_CAP_KIB }), usabilityContext()),
    ).resolves.toBeUndefined();
  });

  it("rejects one KiB over the cap with its own message and both sides of the comparison", async () => {
    const thrown = await assertRepositoryUsable(
      metadata({ sizeKib: REPOSITORY_SIZE_CAP_KIB + 1 }),
      usabilityContext(),
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(UnprocessableEntityError);
    expect(thrown).toMatchObject({ httpStatus: 422 });
    expect((thrown as Error).message).toMatch(/too large/i);
    // Distinct from the empty message — §3 step 6's "not folded into empty" rule
    // applies to every one of these.
    expect((thrown as Error).message).not.toBe(EMPTY_REPOSITORY_MESSAGE);
    expect((thrown as { details: Record<string, unknown> }).details).toMatchObject({
      reason: "REPOSITORY_TOO_LARGE",
      sizeKib: REPOSITORY_SIZE_CAP_KIB + 1,
      capKib: REPOSITORY_SIZE_CAP_KIB,
    });
  });

  it("states the cap in KiB, the unit GitHub reports — not bytes", () => {
    // A bare number in the comparison is the landmine this constant defuses. 500 MiB
    // expressed in KiB; `torvalds/linux` reports 6,350,863 in the same unit.
    expect(REPOSITORY_SIZE_CAP_KIB).toBe(512_000);
  });
});

describe("step 6 — the default branch resolves (422, distinct message)", () => {
  it("rejects a repository with content but no default branch, and does NOT call it empty", async () => {
    const thrown = await assertRepositoryUsable(
      metadata({ sizeKib: 500, defaultBranch: null }),
      usabilityContext(),
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(UnprocessableEntityError);
    expect((thrown as Error).message).toBe(DEFAULT_BRANCH_MESSAGE);
    expect((thrown as Error).message).not.toBe(EMPTY_REPOSITORY_MESSAGE);
  });
});

describe("the six failures are six distinct answers (§15)", () => {
  it("produces six different (status, code, message) triples", async () => {
    const outcomes: Array<{ status: number; code: string; message: string }> = [];
    const capture = (error: unknown) => {
      const e = error as { httpStatus: number; code: string; message: string };
      outcomes.push({ status: e.httpStatus, code: e.code, message: e.message });
    };

    try {
      resolveRepoRefFromUrl("nope");
    } catch (error) {
      capture(error);
    }
    try {
      assertRepositoryAccessible({ ok: false, reason: "NOT_ACCESSIBLE" }, { ...CONTEXT, target: "o/r" });
    } catch (error) {
      capture(error);
    }
    try {
      assertNotAlreadyConnected(
        { id: "repo-1", connectionStatus: "ACTIVE" } as RepositoryRecord,
        { ...CONTEXT, githubRepoId: 1n },
      );
    } catch (error) {
      capture(error);
    }
    await assertRepositoryUsable(metadata({ sizeKib: 0, defaultBranch: null }), usabilityContext()).catch(capture);
    await assertRepositoryUsable(
      metadata({ sizeKib: REPOSITORY_SIZE_CAP_KIB + 1 }),
      usabilityContext(),
    ).catch(capture);
    await assertRepositoryUsable(metadata({ sizeKib: 500, defaultBranch: null }), usabilityContext()).catch(capture);

    expect(outcomes.map((o) => o.status)).toEqual([400, 403, 409, 422, 422, 422]);
    // The three 422s share a status; a generic "connection failed" is exactly what §4
    // forbids, so their messages must still differ.
    expect(new Set(outcomes.map((o) => o.message)).size).toBe(6);
  });
});
