import { prisma } from "@repo/db";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedSignedInUser, type SeededUser } from "./auth-helpers.js";
import { resetDatabase } from "./db-helpers.js";
import {
  githubRepoMetadata,
  seedInstallation,
  type SeededInstallation,
} from "./repository-helpers.js";

// project/deleted and repository/index.requested have no consumer in this phase
// (phase-01 §8, phase-02 §8) and CI has no Inngest server; stubbing the emit boundary
// keeps the suite off the network entirely. Each emit's own behavior is covered by
// src/inngest/emit.test.ts.
vi.mock("../../src/inngest/emit.js", () => ({
  emitProjectDeleted: vi.fn(),
  emitRepositoryIndexRequested: vi.fn(),
}));
// GitHub itself is mocked at this boundary, the same as in repositories.test.ts — the
// GitHub client (token minting, retry, rate limiting, pagination) has its own fixture
// suite (packages/github/src/github-fixtures.test.ts) and does not need re-proving here.
vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/github")>();
  return {
    ...actual,
    installationGithub: {
      listInstallationRepositories: vi.fn(),
      listUserInstallations: vi.fn(),
    },
    repositoryGithub: {
      getRepository: vi.fn(),
      probeBranch: vi.fn(),
    },
  };
});

const { default: app } = await import("../../src/app.js");
const { installationGithub, repositoryGithub } = await import("@repo/github");
const { emitRepositoryIndexRequested } =
  await import("../../src/inngest/emit.js");

/**
 * ══════════════════════════════════════════════════════════════════════════════════
 *  THE CROSS-TENANT ACCESS TEST — written now, extended forever.
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 * phase-01 §13/§14 and plan.md §34.2: this file is the **template every later phase
 * copies**, not a one-off. When Phase 02 adds `Repository`, Phase 07 adds
 * `PullRequest`, Phase 09 adds `Review` — each one adds a block to this pattern, with
 * the same three parts:
 *
 *   1. Seed two users, and one resource owned by user A.
 *   2. For **every** route that takes that resource's id, drive it with user B's
 *      session and assert user B is refused.
 *   3. Assert the refusal is a 404 with a body identical to the one a nonexistent id
 *      produces — a 403, or a differing message, would confirm the resource exists and
 *      turn id-guessing into tenant enumeration (§12).
 *
 * Two rules keep this test honest as it grows:
 *
 * - **Enumerate routes, don't sample them.** A route added without a line here is a
 *   route with no cross-tenant coverage. The `every route` block below is written as a
 *   table for exactly that reason.
 * - **Assert the side effect didn't happen, not just the status code.** A handler that
 *   returns 404 *after* mutating is still a breach; the delete case re-reads the row.
 */

let userA: SeededUser;
let userB: SeededUser;
let projectOfA: { id: string; slug: string };
let installationOfA: SeededInstallation;
let installationOfB: SeededInstallation;
let repositoryOfA: {
  id: string;
  fullName: string;
  githubRepoId: string;
  projectId: string;
};

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(repositoryGithub.getRepository).mockReset();
  vi.mocked(repositoryGithub.probeBranch).mockReset();
  vi.mocked(installationGithub.listInstallationRepositories).mockReset();
  vi.mocked(installationGithub.listUserInstallations).mockReset();

  userA = await seedSignedInUser("user-a");
  userB = await seedSignedInUser("user-b");
  installationOfA = await seedInstallation(userA.id, {
    accountLogin: "user-a",
  });
  installationOfB = await seedInstallation(userB.id, {
    accountLogin: "user-b",
  });

  const created = await request(app)
    .post("/api/projects")
    .set("Cookie", userA.cookie)
    .send({ name: "A's Private Project" });
  expect(created.status).toBe(201);
  projectOfA = created.body.project;

  // A resource for user B to be hostile toward, alongside the project — the whole
  // point of extending this file for Phase 02 (phase-02 §14/§15: "user B cannot view,
  // connect to, or disconnect user A's repositories").
  const metadataForA = githubRepoMetadata({
    owner: "user-a",
    name: "a-private-repo",
  });
  vi.mocked(repositoryGithub.getRepository).mockResolvedValueOnce({
    ok: true,
    repository: metadataForA,
  });
  const connected = await request(app)
    .post(`/api/projects/${projectOfA.id}/repositories`)
    .set("Cookie", userA.cookie)
    .send({
      repoUrl: `https://github.com/${metadataForA.owner}/${metadataForA.name}`,
    });
  expect(connected.status).toBe(202);
  repositoryOfA = connected.body.repository;

  // Clears call HISTORY only (mockReset() above already cleared implementations) — the
  // setup call above must not count against a test body's "was GitHub ever called"
  // assertion.
  vi.mocked(repositoryGithub.getRepository).mockClear();
  // connectRepository's own fire-and-forget emit for the setup connect above must not
  // count against a test body's "no index was triggered" assertion (phase-03 extension).
  vi.mocked(emitRepositoryIndexRequested).mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("cross-tenant access — user B cannot reach user A's project by any route", () => {
  it("GET /api/projects/:id — 404, not 403, not the project", async () => {
    const res = await request(app)
      .get(`/api/projects/${projectOfA.id}`)
      .set("Cookie", userB.cookie);

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty("project");
  });

  it("GET /api/projects — user B's list never contains user A's project", async () => {
    // User B has projects of their own, so this proves scoping rather than emptiness.
    await request(app)
      .post("/api/projects")
      .set("Cookie", userB.cookie)
      .send({ name: "B's Own Project" });

    const res = await request(app)
      .get("/api/projects")
      .set("Cookie", userB.cookie);

    expect(res.status).toBe(200);
    const ids = res.body.projects.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(projectOfA.id);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0].name).toBe("B's Own Project");
  });

  it("DELETE /api/projects/:id — 404, and user A's project is untouched", async () => {
    const res = await request(app)
      .delete(`/api/projects/${projectOfA.id}`)
      .set("Cookie", userB.cookie);

    expect(res.status).toBe(404);

    // The status code alone would not catch a handler that soft-deletes and *then*
    // discovers it should not have.
    const row = await prisma.project.findUniqueOrThrow({
      where: { id: projectOfA.id },
    });
    expect(row.deletedAt).toBeNull();
    expect(row.userId).toBe(userA.id);
  });

  it("refuses identically whether the project is foreign or nonexistent — no existence oracle", async () => {
    const foreign = await request(app)
      .get(`/api/projects/${projectOfA.id}`)
      .set("Cookie", userB.cookie);
    const nonexistent = await request(app)
      .get("/api/projects/00000000-0000-0000-0000-000000000000")
      .set("Cookie", userB.cookie);

    expect(foreign.status).toBe(nonexistent.status);
    expect(foreign.body).toEqual(nonexistent.body);
  });

  it("user A is still able to reach their own project — the isolation is not just a blanket deny", async () => {
    const res = await request(app)
      .get(`/api/projects/${projectOfA.id}`)
      .set("Cookie", userA.cookie);

    expect(res.status).toBe(200);
    expect(res.body.project.id).toBe(projectOfA.id);
  });
});

describe("cross-tenant access — per-user slug namespaces do not collide", () => {
  it("lets user B create a project whose slug user A already uses", async () => {
    // `@@unique([userId, slug])` is per user, so B's "A's Private Project" gets the
    // same slug A has. A shared slug namespace here would leak A's project names to B
    // through 409s.
    const res = await request(app)
      .post("/api/projects")
      .set("Cookie", userB.cookie)
      .send({ name: "A's Private Project" });

    expect(res.status).toBe(201);
    expect(res.body.project.slug).toBe(projectOfA.slug);
    expect(res.body.project.id).not.toBe(projectOfA.id);
  });
});

describe("cross-tenant access — a revoked session stops authenticating immediately", () => {
  it("returns 401 once user B's session row is gone (phase-01 §15 sign-out)", async () => {
    const staleCookie = userB.cookie;
    await request(app)
      .get("/api/projects")
      .set("Cookie", staleCookie)
      .expect(200);

    // Exactly what Auth.js's signout action does: delete the Session row. This is the
    // property database sessions exist for (§1/§22 — JWTs cannot be revoked).
    await prisma.session.deleteMany({ where: { userId: userB.id } });

    const res = await request(app)
      .get("/api/projects")
      .set("Cookie", staleCookie);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════
 *  PHASE 02 EXTENSION — repositories, following the exact same three-part pattern.
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 * phase-02 §14/§15: "user B cannot view, connect to, or disconnect user A's
 * repositories" (automated test), plus the dual-project case that is the actual named
 * failure point (`plan.md` §45 — assuming `githubRepoId` is globally unique).
 *
 * **On the FOREIGN vs MISSING log-content assertion** (sub-task 3.4's "assert the
 * denial warn log lines carry the right reason"): that assertion already exists,
 * precisely, at the unit level — `src/lib/auth/tenant-access.test.ts` mocks
 * `createLogger` directly and asserts the exact `{projectId, userId, reason,
 * repositoryId}` payload for FOREIGN, MISSING, DELETED, and MISMATCH on the repository
 * path. Re-asserting it here would mean capturing the shared module-level pino
 * instance's real stdout output — pino's default destination writes through
 * `sonic-boom`, which buffers asynchronously, so a stdout-spy assertion in an HTTP-level
 * integration test would be racing pino's own internals rather than proving anything
 * about `tenant-access.ts`. `requireTenantAccess`'s logger is not an injectable
 * parameter (unlike the GitHub client's), so there is no seam here to swap it through
 * cleanly the way `github-fixtures.test.ts` does. This file instead proves the same
 * distinction the way an HTTP-level test can: every case below gets the SAME 404,
 * whether it is FOREIGN or MISSING underneath, and the database is asserted unchanged —
 * which is the property the log split exists to make debuggable, not the property the
 * caller-visible contract depends on.
 */

describe("cross-tenant access — user B cannot reach user A's repository by any route", () => {
  it("GET /api/repositories/:id — 404, not 403, not the repository", async () => {
    const res = await request(app)
      .get(`/api/repositories/${repositoryOfA.id}`)
      .set("Cookie", userB.cookie);

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty("repository");
  });

  it("DELETE /api/repositories/:id — 404, and user A's repository is unchanged in the database", async () => {
    const res = await request(app)
      .delete(`/api/repositories/${repositoryOfA.id}`)
      .set("Cookie", userB.cookie);

    expect(res.status).toBe(404);

    // The status code alone would not catch a handler that disconnects and *then*
    // discovers it should not have — same discipline as the project DELETE case above.
    const row = await prisma.repository.findUniqueOrThrow({
      where: { id: repositoryOfA.id },
    });
    expect(row.connectionStatus).toBe("ACTIVE");
    expect(row.projectId).toBe(projectOfA.id);
  });

  it("POST /api/projects/:id/repositories — 404 for user A's project, from user B, before any GitHub call", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectOfA.id}/repositories`)
      .set("Cookie", userB.cookie)
      .send({ repoUrl: "https://github.com/user-a/some-other-repo" });

    expect(res.status).toBe(404);
    expect(repositoryGithub.getRepository).not.toHaveBeenCalled();
  });

  it("GET /api/projects/:id — 404, and user A's repository never appears in user B's project detail", async () => {
    const res = await request(app)
      .get(`/api/projects/${projectOfA.id}`)
      .set("Cookie", userB.cookie);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(repositoryOfA.fullName);
  });

  it("refuses identically whether the repository is foreign or nonexistent — no existence oracle", async () => {
    const foreign = await request(app)
      .get(`/api/repositories/${repositoryOfA.id}`)
      .set("Cookie", userB.cookie);
    const nonexistent = await request(app)
      .get("/api/repositories/00000000-0000-0000-0000-000000000000")
      .set("Cookie", userB.cookie);

    expect(foreign.status).toBe(nonexistent.status);
    expect(foreign.body).toEqual(nonexistent.body);
  });

  it("user A is still able to reach their own repository — the isolation is not just a blanket deny", async () => {
    const res = await request(app)
      .get(`/api/repositories/${repositoryOfA.id}`)
      .set("Cookie", userA.cookie);

    expect(res.status).toBe(200);
    expect(res.body.repository.id).toBe(repositoryOfA.id);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════
 *  PHASE 03 EXTENSION — the two new indexing routes, same three-part pattern.
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 * phase-03 §3.2: "a user must not be able to read another tenant's index status or
 * trigger another tenant's index — the single easiest place for a phase to introduce a
 * leak." Both routes share `requireTenantAccess` with every other repository route
 * (`getIndexStatus`/`triggerIndex` in repository.service.ts), so this is confirmation
 * that the shared seam actually covers the new routes too, not a new mechanism.
 */
describe("cross-tenant access — user B cannot reach user A's repository's index state or trigger its indexing", () => {
  it("GET /api/repositories/:id/index-status — 404, not 403, not the status", async () => {
    const res = await request(app)
      .get(`/api/repositories/${repositoryOfA.id}/index-status`)
      .set("Cookie", userB.cookie);

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty("status");
    expect(res.body).not.toHaveProperty("progressPercent");
  });

  it("POST /api/repositories/:id/index — 404 for user A's repository, from user B, and no index is triggered", async () => {
    const res = await request(app)
      .post(`/api/repositories/${repositoryOfA.id}/index`)
      .set("Cookie", userB.cookie)
      .send({ mode: "FULL" });

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty("indexJobId");
    expect(emitRepositoryIndexRequested).not.toHaveBeenCalled();

    // The status code alone would not catch a handler that flips the lock and *then*
    // discovers it should not have — same discipline as the DELETE cases above.
    const row = await prisma.repository.findUniqueOrThrow({
      where: { id: repositoryOfA.id },
    });
    expect(row.indexStatus).not.toBe("INDEXING");
  });

  it("refuses identically whether the repository is foreign or nonexistent — no existence oracle", async () => {
    const foreign = await request(app)
      .get(`/api/repositories/${repositoryOfA.id}/index-status`)
      .set("Cookie", userB.cookie);
    const nonexistent = await request(app)
      .get(
        "/api/repositories/00000000-0000-0000-0000-000000000000/index-status",
      )
      .set("Cookie", userB.cookie);

    expect(foreign.status).toBe(nonexistent.status);
    expect(foreign.body).toEqual(nonexistent.body);
  });

  it("user A is still able to read their own repository's index status and trigger its indexing — not a blanket deny", async () => {
    const statusRes = await request(app)
      .get(`/api/repositories/${repositoryOfA.id}/index-status`)
      .set("Cookie", userA.cookie);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body).toHaveProperty("status");

    const triggerRes = await request(app)
      .post(`/api/repositories/${repositoryOfA.id}/index`)
      .set("Cookie", userA.cookie)
      .send({ mode: "FULL" });
    expect(triggerRes.status).toBe(202);
    expect(triggerRes.body).toHaveProperty("indexJobId");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════
 *  PHASE 04 EXTENSION — the knowledge route, same three-part pattern.
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 * phase-04 §7: `GET /api/repositories/:id/knowledge` shares `requireTenantAccess` with
 * every other repository route — this confirms the shared seam covers it too, and that
 * no aggregate query in `knowledge.repository.ts` is reachable before tenancy is proven.
 */
describe("cross-tenant access — user B cannot reach user A's repository's knowledge graph", () => {
  it("GET /api/repositories/:id/knowledge — 404, not 403, not the aggregates", async () => {
    const res = await request(app)
      .get(`/api/repositories/${repositoryOfA.id}/knowledge`)
      .set("Cookie", userB.cookie);

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty("fileCount");
    expect(res.body).not.toHaveProperty("symbolCount");
  });

  it("refuses identically whether the repository is foreign or nonexistent — no existence oracle", async () => {
    const foreign = await request(app)
      .get(`/api/repositories/${repositoryOfA.id}/knowledge`)
      .set("Cookie", userB.cookie);
    const nonexistent = await request(app)
      .get("/api/repositories/00000000-0000-0000-0000-000000000000/knowledge")
      .set("Cookie", userB.cookie);

    expect(foreign.status).toBe(nonexistent.status);
    expect(foreign.body).toEqual(nonexistent.body);
  });

  it("user A is still able to read their own repository's knowledge graph — not a blanket deny", async () => {
    const res = await request(app)
      .get(`/api/repositories/${repositoryOfA.id}/knowledge`)
      .set("Cookie", userA.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("fileCount");
  });
});

describe("cross-tenant access — GitHub installations", () => {
  it("GET /api/github/installations — user B's list only ever contains user B's own installations", async () => {
    await prisma.account.create({
      data: {
        userId: userB.id,
        type: "oauth",
        provider: "github",
        providerAccountId: "gh-user-b",
        access_token: "fixture-oauth-token-b",
      },
    });
    // `GET /api/github/installations` syncs before it answers (§10) — it returns what
    // THIS sync found, not a raw re-read of every stored row (see repository.service.ts
    // syncInstallations). In production that is equivalent to "all of B's current
    // installations" because listUserInstallations always returns GitHub's complete,
    // fully-paginated current list; modelling anything less here (e.g. an empty
    // response) would test an unrealistic scenario, not the real scoping property.
    vi.mocked(installationGithub.listUserInstallations).mockResolvedValueOnce({
      ok: true,
      installations: [
        {
          installationId: installationOfB.installationId,
          accountLogin: "user-b",
          accountType: "User",
          suspended: false,
        },
      ],
    });

    const res = await request(app)
      .get("/api/github/installations")
      .set("Cookie", userB.cookie);

    expect(res.status).toBe(200);
    const ids = res.body.installations.map(
      (installation: { installationId: string }) => installation.installationId,
    );
    expect(ids).toEqual([installationOfB.installationId.toString()]);
    expect(ids).not.toContain(installationOfA.installationId.toString());
  });

  it("GET /api/github/installations/:id/repos — 403 for an installation user B does not own", async () => {
    // The deliberate exception to this file's usual 404 (docs/decisions/phase-02-log.md
    // §19): an installation id is a GitHub-global integer the user can already read on
    // github.com, not this system's identifier, so confirming it names *an*
    // installation is not an enumeration oracle the way a project/repository uuid is.
    // What stays protected — the repository names it can see — never leaves the server:
    // this assertion is that the ownership check refuses before any GitHub call is made.
    const res = await request(app)
      .get(`/api/github/installations/${installationOfA.installationId}/repos`)
      .set("Cookie", userB.cookie);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(
      installationGithub.listInstallationRepositories,
    ).not.toHaveBeenCalled();
  });

  it("user B can still list repositories through their OWN installation — not a blanket deny", async () => {
    vi.mocked(
      installationGithub.listInstallationRepositories,
    ).mockResolvedValueOnce({
      ok: true,
      repositories: [
        {
          githubRepoId: 555_000_111n,
          owner: "user-b",
          name: "b-repo",
          fullName: "user-b/b-repo",
          isPrivate: false,
          defaultBranch: "main",
        },
      ],
    });

    const res = await request(app)
      .get(`/api/github/installations/${installationOfB.installationId}/repos`)
      .set("Cookie", userB.cookie);

    expect(res.status).toBe(200);
    expect(res.body.repos).toHaveLength(1);
  });
});

describe("cross-tenant access — the dual-project case (plan.md §45's named failure point)", () => {
  it("user B connects the SAME GitHub repository user A already connected, to user B's OWN project — succeeds, and B gets access to only B's own row", async () => {
    const projectOfB = await request(app)
      .post("/api/projects")
      .set("Cookie", userB.cookie)
      .send({ name: "B's Own Project" })
      .expect(201);

    // The same githubRepoId user A's repository carries, resolved this time through
    // B's OWN installation via the id path — modelling a repository both users'
    // installations can independently see (a shared org, or a public repository). A
    // `githubRepoId`-keyed lookup, or an assumption that this id is globally unique,
    // would show up here as either a spurious 409 or a genuine cross-tenant leak
    // (docs/decisions/phase-02-log.md §4/§23; repository.repository.ts's header).
    const sharedGithubRepoId = BigInt(repositoryOfA.githubRepoId);
    vi.mocked(
      installationGithub.listInstallationRepositories,
    ).mockResolvedValueOnce({
      ok: true,
      repositories: [
        {
          githubRepoId: sharedGithubRepoId,
          owner: "user-a",
          name: "a-private-repo",
          fullName: "user-a/a-private-repo",
          isPrivate: false,
          defaultBranch: "main",
        },
      ],
    });
    vi.mocked(repositoryGithub.getRepository).mockResolvedValueOnce({
      ok: true,
      repository: githubRepoMetadata({
        owner: "user-a",
        name: "a-private-repo",
        githubRepoId: sharedGithubRepoId,
      }),
    });

    const res = await request(app)
      .post(`/api/projects/${projectOfB.body.project.id}/repositories`)
      .set("Cookie", userB.cookie)
      .send({ githubRepoId: sharedGithubRepoId.toString() });

    expect(res.status).toBe(202);
    expect(res.body.repository.id).not.toBe(repositoryOfA.id);
    expect(res.body.repository.projectId).toBe(projectOfB.body.project.id);

    const rows = await prisma.repository.findMany({
      where: { githubRepoId: sharedGithubRepoId },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.projectId))).toEqual(
      new Set([projectOfA.id, projectOfB.body.project.id]),
    );

    // B can read B's own new row...
    const bReadsOwn = await request(app)
      .get(`/api/repositories/${res.body.repository.id}`)
      .set("Cookie", userB.cookie);
    expect(bReadsOwn.status).toBe(200);
    // ...but still never A's, even though the two rows now share a githubRepoId.
    const bReadsA = await request(app)
      .get(`/api/repositories/${repositoryOfA.id}`)
      .set("Cookie", userB.cookie);
    expect(bReadsA.status).toBe(404);
  });
});
