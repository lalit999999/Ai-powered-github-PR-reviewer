import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRecord } from "./project.types.js";

// The repository is the seam (it owns the Prisma import), and emit.ts is stubbed so no
// unit test ever opens a socket to Inngest. All three mocks are hoisted above the
// imports below, so neither @repo/db nor the config module is ever loaded here.
//
// project.service.ts also imports the repositories module's service (for
// getProjectDetail's repository list), which is not exercised by any test in this file
// but is still a static top-level import — and, through installation.repository.js /
// repository.repository.js, an unmocked path to @repo/db. Mocked for exactly that
// reason, not because this file tests it.
vi.mock("./project.repository.js", () => ({
  create: vi.fn(),
  findSlugsForUserByPrefix: vi.fn(),
  findByIdForUser: vi.fn(),
  listByUser: vi.fn(),
  softDeleteForUser: vi.fn(),
}));
vi.mock("../repositories/repository.service.js", () => ({
  listProjectRepositories: vi.fn(),
}));
vi.mock("../../inngest/emit.js", () => ({ emitProjectDeleted: vi.fn() }));

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

const projectRepository = await import("./project.repository.js");
const { emitProjectDeleted } = await import("../../inngest/emit.js");
const { ConflictError } = await import("../../lib/errors.js");
const {
  createProject,
  listProjects,
  nextSuffixedSlug,
  slugify,
  softDeleteProject,
} = await import("./project.service.js");

const USER_ID = "user-a";
const OWNER = { userId: USER_ID };

function projectRow(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "project-1",
    userId: USER_ID,
    name: "Test Project",
    slug: "test-project",
    settings: {},
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const mockedCreate = vi.mocked(projectRepository.create);
const mockedFindSlugs = vi.mocked(projectRepository.findSlugsForUserByPrefix);
const mockedListByUser = vi.mocked(projectRepository.listByUser);
const mockedSoftDelete = vi.mocked(projectRepository.softDeleteForUser);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("slugify (phase-01 §4 — slugs are derived from the name)", () => {
  it.each([
    ["Test Project", "test-project"],
    ["  Leading and trailing  ", "leading-and-trailing"],
    ["UPPER CASE", "upper-case"],
    ["punctuation!!! ...everywhere???", "punctuation-everywhere"],
    ["Café Münster", "cafe-munster"],
    ["multi---dash", "multi-dash"],
    ["v2.0 release", "v2-0-release"],
    ["_underscored_name_", "underscored-name"],
    ["123", "123"],
  ])("%j -> %j", (name, expected) => {
    expect(slugify(name)).toBe(expected);
  });

  it("falls back rather than producing an empty slug for a name with nothing sluggable", () => {
    // Names are validated non-empty, but "non-empty" and "contains a URL-safe
    // character" are different things — an empty slug would break the unique
    // constraint's usefulness and produce an unaddressable project.
    expect(slugify("🙂🙂🙂")).toBe("project");
    expect(slugify("!!!")).toBe("project");
  });

  it("truncates long names without leaving a trailing separator", () => {
    const slug = slugify("a".repeat(60) + " " + "b".repeat(60));
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("nextSuffixedSlug (the numeric suffix used by the single retry)", () => {
  it("starts at 2 when only the bare slug is taken", () => {
    expect(nextSuffixedSlug("api", ["api"])).toBe("api-2");
  });

  it("continues past the highest existing suffix", () => {
    expect(nextSuffixedSlug("api", ["api", "api-2", "api-3"])).toBe("api-4");
  });

  it("ignores slugs that merely share the prefix", () => {
    // `startsWith` matching means "api-gateway" comes back from the same query.
    expect(nextSuffixedSlug("api", ["api", "api-gateway", "apiary"])).toBe(
      "api-2",
    );
  });

  it("is unaffected by gaps in the numbering", () => {
    expect(nextSuffixedSlug("api", ["api", "api-7"])).toBe("api-8");
  });
});

describe("createProject — per-user uniqueness, one retry, then 409 (phase-01 §12/§22)", () => {
  it("stores the derived slug when it is free", async () => {
    mockedCreate.mockResolvedValueOnce({ ok: true, project: projectRow() });

    const dto = await createProject(OWNER, { name: "Test Project" });

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedCreate).toHaveBeenCalledWith(USER_ID, {
      name: "Test Project",
      slug: "test-project",
    });
    expect(dto.slug).toBe("test-project");
  });

  it("retries exactly once with a numeric suffix when the slug is taken", async () => {
    mockedCreate
      .mockResolvedValueOnce({ ok: false, reason: "SLUG_TAKEN" })
      .mockResolvedValueOnce({
        ok: true,
        project: projectRow({ id: "project-2", slug: "test-project-2" }),
      });
    mockedFindSlugs.mockResolvedValueOnce(["test-project"]);

    const dto = await createProject(OWNER, { name: "Test Project" });

    expect(dto.slug).toBe("test-project-2");
    expect(mockedCreate).toHaveBeenNthCalledWith(2, USER_ID, {
      name: "Test Project",
      slug: "test-project-2",
    });
  });

  it("gives up with a 409 after the single retry — it never loops", async () => {
    mockedCreate
      .mockResolvedValueOnce({ ok: false, reason: "SLUG_TAKEN" })
      .mockResolvedValueOnce({ ok: false, reason: "SLUG_TAKEN" });
    mockedFindSlugs.mockResolvedValueOnce(["test-project"]);

    const promise = createProject(OWNER, { name: "Test Project" });

    await expect(promise).rejects.toBeInstanceOf(ConflictError);
    await expect(promise).rejects.toMatchObject({
      httpStatus: 409,
      code: "CONFLICT",
    });
    // Two attempts total. A third would mean the "one retry, not a loop" rule
    // (phase-01 §12) had turned into an unbounded retry under contention.
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  it("scopes the uniqueness probe to the calling user", async () => {
    mockedCreate
      .mockResolvedValueOnce({ ok: false, reason: "SLUG_TAKEN" })
      .mockResolvedValueOnce({
        ok: true,
        project: projectRow({ slug: "test-project-2" }),
      });
    mockedFindSlugs.mockResolvedValueOnce(["test-project"]);

    await createProject(OWNER, { name: "Test Project" });

    expect(mockedFindSlugs).toHaveBeenCalledWith(USER_ID, "test-project");
  });

  it("logs the create at info with component fields (phase-01 §20)", async () => {
    mockedCreate.mockResolvedValueOnce({ ok: true, project: projectRow() });

    await createProject(OWNER, { name: "Test Project" });

    expect(logSpies.info).toHaveBeenCalledWith("project created", {
      projectId: "project-1",
      userId: USER_ID,
      slug: "test-project",
    });
  });
});

describe("listProjects — cursor paging", () => {
  it("returns nextCursor when the repository yields the extra look-ahead row", async () => {
    mockedListByUser.mockResolvedValueOnce([
      projectRow({ id: "p1" }),
      projectRow({ id: "p2" }),
      projectRow({ id: "p3" }),
    ]);

    const page = await listProjects(OWNER, { limit: 2 });

    expect(page.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(page.nextCursor).toBe("p2");
    expect(mockedListByUser).toHaveBeenCalledWith(USER_ID, {
      limit: 2,
      cursor: undefined,
    });
  });

  it("returns a null cursor on the last page", async () => {
    mockedListByUser.mockResolvedValueOnce([projectRow({ id: "p1" })]);

    await expect(listProjects(OWNER, { limit: 2 })).resolves.toMatchObject({
      nextCursor: null,
    });
  });

  it("returns a null cursor for an empty list", async () => {
    mockedListByUser.mockResolvedValueOnce([]);

    await expect(listProjects(OWNER, { limit: 2 })).resolves.toEqual({
      projects: [],
      nextCursor: null,
    });
  });
});

describe("softDeleteProject — idempotent, emits only on a real transition (phase-01 §4/§8)", () => {
  const TENANT = { userId: USER_ID, projectId: "project-1" };

  it("emits project/deleted when the project actually transitioned", async () => {
    mockedSoftDelete.mockResolvedValueOnce(1);

    await softDeleteProject(TENANT);

    expect(emitProjectDeleted).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(logSpies.info).toHaveBeenCalledWith("project soft-deleted", {
      projectId: "project-1",
      userId: USER_ID,
    });
  });

  it("succeeds without re-emitting when the project was already deleted", async () => {
    mockedSoftDelete.mockResolvedValueOnce(0);

    await expect(softDeleteProject(TENANT)).resolves.toBeUndefined();

    expect(emitProjectDeleted).not.toHaveBeenCalled();
  });
});
