import { prisma } from "@repo/db";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedSignedInUser, type SeededUser } from "./auth-helpers.js";
import { resetDatabase } from "./db-helpers.js";

// project/deleted has no consumer in this phase (phase-01 §8) and CI has no Inngest
// server; stubbing the emit boundary keeps the suite off the network entirely. The
// emit's own behavior is covered by src/inngest/emit.test.ts.
vi.mock("../../src/inngest/emit.js", () => ({ emitProjectDeleted: vi.fn() }));

const { default: app } = await import("../../src/app.js");

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

beforeEach(async () => {
  await resetDatabase();

  userA = await seedSignedInUser("user-a");
  userB = await seedSignedInUser("user-b");

  const created = await request(app)
    .post("/api/projects")
    .set("Cookie", userA.cookie)
    .send({ name: "A's Private Project" });
  expect(created.status).toBe(201);
  projectOfA = created.body.project;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("cross-tenant access — user B cannot reach user A's project by any route", () => {
  it("GET /api/projects/:id — 404, not 403, not the project", async () => {
    const res = await request(app).get(`/api/projects/${projectOfA.id}`).set("Cookie", userB.cookie);

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty("project");
  });

  it("GET /api/projects — user B's list never contains user A's project", async () => {
    // User B has projects of their own, so this proves scoping rather than emptiness.
    await request(app).post("/api/projects").set("Cookie", userB.cookie).send({ name: "B's Own Project" });

    const res = await request(app).get("/api/projects").set("Cookie", userB.cookie);

    expect(res.status).toBe(200);
    const ids = res.body.projects.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(projectOfA.id);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0].name).toBe("B's Own Project");
  });

  it("DELETE /api/projects/:id — 404, and user A's project is untouched", async () => {
    const res = await request(app).delete(`/api/projects/${projectOfA.id}`).set("Cookie", userB.cookie);

    expect(res.status).toBe(404);

    // The status code alone would not catch a handler that soft-deletes and *then*
    // discovers it should not have.
    const row = await prisma.project.findUniqueOrThrow({ where: { id: projectOfA.id } });
    expect(row.deletedAt).toBeNull();
    expect(row.userId).toBe(userA.id);
  });

  it("refuses identically whether the project is foreign or nonexistent — no existence oracle", async () => {
    const foreign = await request(app).get(`/api/projects/${projectOfA.id}`).set("Cookie", userB.cookie);
    const nonexistent = await request(app)
      .get("/api/projects/00000000-0000-0000-0000-000000000000")
      .set("Cookie", userB.cookie);

    expect(foreign.status).toBe(nonexistent.status);
    expect(foreign.body).toEqual(nonexistent.body);
  });

  it("user A is still able to reach their own project — the isolation is not just a blanket deny", async () => {
    const res = await request(app).get(`/api/projects/${projectOfA.id}`).set("Cookie", userA.cookie);

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
    await request(app).get("/api/projects").set("Cookie", staleCookie).expect(200);

    // Exactly what Auth.js's signout action does: delete the Session row. This is the
    // property database sessions exist for (§1/§22 — JWTs cannot be revoked).
    await prisma.session.deleteMany({ where: { userId: userB.id } });

    const res = await request(app).get("/api/projects").set("Cookie", staleCookie);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });
});
