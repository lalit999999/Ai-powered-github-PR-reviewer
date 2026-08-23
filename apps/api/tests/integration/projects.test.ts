import { prisma } from "@repo/db";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedSignedInUser, type SeededUser } from "./auth-helpers.js";
import { resetDatabase } from "./db-helpers.js";

vi.mock("../../src/inngest/emit.js", () => ({ emitProjectDeleted: vi.fn() }));

const { emitProjectDeleted } = await import("../../src/inngest/emit.js");
const { default: app } = await import("../../src/app.js");

let user: SeededUser;

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(emitProjectDeleted).mockClear();
  user = await seedSignedInUser("octocat");
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Route contracts from phase-01 §7, driven end to end through the real Express app with
 * a real database session cookie.
 */

describe("authentication — every project route is 401 without a session (phase-01 §14 Failure Verification)", () => {
  const routes = [
    ["get", "/api/projects"],
    ["post", "/api/projects"],
    ["get", "/api/projects/some-id"],
    ["delete", "/api/projects/some-id"],
  ] as const;

  for (const [method, path] of routes) {
    it(`${method.toUpperCase()} ${path} returns 401 — not a redirect, not a 500`, async () => {
      const res = await request(app)[method](path).send({});

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
      // An API that 302s here is the redirect loop §14 explicitly warns about.
      expect(res.headers.location).toBeUndefined();
    });
  }

  it("treats an unknown session token as signed out rather than falling open", async () => {
    const res = await request(app).get("/api/projects").set("Cookie", "authjs.session-token=not-a-real-token");

    expect(res.status).toBe(401);
  });

  it("treats an expired session as signed out", async () => {
    const expiredToken = "expired-session-token";
    await prisma.session.create({
      data: { sessionToken: expiredToken, userId: user.id, expires: new Date(Date.now() - 60_000) },
    });

    const res = await request(app).get("/api/projects").set("Cookie", `authjs.session-token=${expiredToken}`);

    expect(res.status).toBe(401);
  });
});

describe("POST /api/projects", () => {
  it("creates a project owned by the caller and returns 201 { project }", async () => {
    const res = await request(app).post("/api/projects").set("Cookie", user.cookie).send({ name: "Test Project" });

    expect(res.status).toBe(201);
    expect(res.body.project).toMatchObject({ name: "Test Project", slug: "test-project" });

    const row = await prisma.project.findUniqueOrThrow({ where: { id: res.body.project.id } });
    expect(row.userId).toBe(user.id);
    expect(row.deletedAt).toBeNull();
  });

  it("does not leak userId or deletedAt into the DTO", async () => {
    const res = await request(app).post("/api/projects").set("Cookie", user.cookie).send({ name: "Test Project" });

    expect(Object.keys(res.body.project).sort()).toEqual(
      ["createdAt", "id", "name", "settings", "slug", "updatedAt"].sort()
    );
  });

  it.each([
    ["an empty name", { name: "" }],
    ["a whitespace-only name", { name: "   " }],
    ["a missing name", {}],
    ["a name over 100 characters", { name: "x".repeat(101) }],
    ["a non-string name", { name: 42 }],
  ])("returns 400 for %s", async (_label, body) => {
    const res = await request(app).post("/api/projects").set("Cookie", user.cookie).send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("suffixes the slug rather than failing when the same user reuses a name", async () => {
    await request(app).post("/api/projects").set("Cookie", user.cookie).send({ name: "Duplicate" }).expect(201);

    const second = await request(app).post("/api/projects").set("Cookie", user.cookie).send({ name: "Duplicate" });

    expect(second.status).toBe(201);
    expect(second.body.project.slug).toBe("duplicate-2");
  });

  it("still suffixes when the colliding slug belongs to a soft-deleted project", async () => {
    // `@@unique([userId, slug])` has no deletedAt in it, so the deleted project keeps
    // its slug — the retry has to see it (phase-01 §11: soft delete only).
    const first = await request(app)
      .post("/api/projects")
      .set("Cookie", user.cookie)
      .send({ name: "Recycled" })
      .expect(201);
    await request(app).delete(`/api/projects/${first.body.project.id}`).set("Cookie", user.cookie).expect(202);

    const second = await request(app).post("/api/projects").set("Cookie", user.cookie).send({ name: "Recycled" });

    expect(second.status).toBe(201);
    expect(second.body.project.slug).toBe("recycled-2");
  });
});

describe("POST /api/projects — concurrent identical names (phase-01 §14 Database Verification, §22)", () => {
  it("two simultaneous creates produce no duplicate and no crash", async () => {
    const [first, second] = await Promise.all([
      request(app).post("/api/projects").set("Cookie", user.cookie).send({ name: "Race Condition" }),
      request(app).post("/api/projects").set("Cookie", user.cookie).send({ name: "Race Condition" }),
    ]);

    // The contract: either two distinct slugs, or one success plus a clean 409 —
    // never a 500, and never two rows sharing a slug.
    for (const res of [first, second]) {
      expect([201, 409]).toContain(res.status);
    }
    expect([first.status, second.status]).toContain(201);

    const rows = await prisma.project.findMany({ where: { userId: user.id } });
    const slugs = rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(rows.length).toBe([first.status, second.status].filter((s) => s === 201).length);
  });

  it("survives five simultaneous creates of the same name without a 500 or a duplicate", async () => {
    // With more contention than one retry can absorb, the extra losers must surface as
    // 409s — the deliberate "one retry, not a loop" outcome (phase-01 §12).
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post("/api/projects").set("Cookie", user.cookie).send({ name: "Thundering Herd" })
      )
    );

    for (const res of results) {
      expect([201, 409]).toContain(res.status);
    }

    const rows = await prisma.project.findMany({ where: { userId: user.id } });
    const slugs = rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(rows.length).toBe(results.filter((r) => r.status === 201).length);
  });
});

describe("GET /api/projects", () => {
  it("returns only the caller's non-deleted projects", async () => {
    const kept = await request(app).post("/api/projects").set("Cookie", user.cookie).send({ name: "Kept" });
    const removed = await request(app).post("/api/projects").set("Cookie", user.cookie).send({ name: "Removed" });
    await request(app).delete(`/api/projects/${removed.body.project.id}`).set("Cookie", user.cookie).expect(202);

    const res = await request(app).get("/api/projects").set("Cookie", user.cookie);

    expect(res.status).toBe(200);
    expect(res.body.projects.map((p: { id: string }) => p.id)).toEqual([kept.body.project.id]);
    expect(res.body.nextCursor).toBeNull();
  });

  it("paginates with a bounded limit and a cursor", async () => {
    for (const name of ["One", "Two", "Three"]) {
      await request(app).post("/api/projects").set("Cookie", user.cookie).send({ name }).expect(201);
    }

    const firstPage = await request(app).get("/api/projects?limit=2").set("Cookie", user.cookie);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.projects).toHaveLength(2);
    expect(firstPage.body.nextCursor).toBeTruthy();

    const secondPage = await request(app)
      .get(`/api/projects?limit=2&cursor=${firstPage.body.nextCursor}`)
      .set("Cookie", user.cookie);

    expect(secondPage.status).toBe(200);
    expect(secondPage.body.projects).toHaveLength(1);
    expect(secondPage.body.nextCursor).toBeNull();

    const firstIds = firstPage.body.projects.map((p: { id: string }) => p.id);
    const secondIds = secondPage.body.projects.map((p: { id: string }) => p.id);
    expect(firstIds.filter((id: string) => secondIds.includes(id))).toHaveLength(0);
  });

  it.each([
    ["limit above the §7 bound of 50", "?limit=51"],
    ["a zero limit", "?limit=0"],
    ["a non-numeric limit", "?limit=lots"],
  ])("returns 400 for %s", async (_label, query) => {
    const res = await request(app).get(`/api/projects${query}`).set("Cookie", user.cookie);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/projects/:id", () => {
  it("returns { project, repositories: [] } — repositories present but empty until Phase 02", async () => {
    const created = await request(app)
      .post("/api/projects")
      .set("Cookie", user.cookie)
      .send({ name: "Detail Project" })
      .expect(201);

    const res = await request(app).get(`/api/projects/${created.body.project.id}`).set("Cookie", user.cookie);

    expect(res.status).toBe(200);
    expect(res.body.project.id).toBe(created.body.project.id);
    // The field's presence is the contract; Phase 02 fills it (phase-01 §7).
    expect(res.body).toHaveProperty("repositories");
    expect(res.body.repositories).toEqual([]);
  });

  it("returns 404 for a soft-deleted project", async () => {
    const created = await request(app)
      .post("/api/projects")
      .set("Cookie", user.cookie)
      .send({ name: "Gone" })
      .expect(201);
    await request(app).delete(`/api/projects/${created.body.project.id}`).set("Cookie", user.cookie).expect(202);

    const res = await request(app).get(`/api/projects/${created.body.project.id}`).set("Cookie", user.cookie);

    expect(res.status).toBe(404);
  });

  it("returns 404 for an id that was never a project", async () => {
    const res = await request(app).get("/api/projects/definitely-not-an-id").set("Cookie", user.cookie);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("DELETE /api/projects/:id — soft delete (phase-01 §11, §4 Reliability)", () => {
  it("sets deletedAt, removes it from the list, and leaves the row in place", async () => {
    const created = await request(app)
      .post("/api/projects")
      .set("Cookie", user.cookie)
      .send({ name: "Soft Delete Me" })
      .expect(201);
    const projectId = created.body.project.id;
    const countBefore = await prisma.project.count();

    const res = await request(app).delete(`/api/projects/${projectId}`).set("Cookie", user.cookie);
    expect(res.status).toBe(202);

    const row = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(row.deletedAt).toBeInstanceOf(Date);
    // No hard delete happened — the row count is unchanged (§14 Database Verification).
    expect(await prisma.project.count()).toBe(countBefore);

    const list = await request(app).get("/api/projects").set("Cookie", user.cookie);
    expect(list.body.projects).toHaveLength(0);
  });

  it("is idempotent — a second delete returns success, not an error", async () => {
    const created = await request(app)
      .post("/api/projects")
      .set("Cookie", user.cookie)
      .send({ name: "Delete Twice" })
      .expect(201);
    const projectId = created.body.project.id;

    const first = await request(app).delete(`/api/projects/${projectId}`).set("Cookie", user.cookie);
    const firstDeletedAt = (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).deletedAt;

    const second = await request(app).delete(`/api/projects/${projectId}`).set("Cookie", user.cookie);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    // The repeat call must not move the original deletion timestamp.
    const after = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(after.deletedAt?.toISOString()).toBe(firstDeletedAt?.toISOString());
  });

  it("emits project/deleted once, on the transition only (phase-01 §8)", async () => {
    const created = await request(app)
      .post("/api/projects")
      .set("Cookie", user.cookie)
      .send({ name: "Emits Once" })
      .expect(201);
    const projectId = created.body.project.id;

    await request(app).delete(`/api/projects/${projectId}`).set("Cookie", user.cookie).expect(202);
    await request(app).delete(`/api/projects/${projectId}`).set("Cookie", user.cookie).expect(202);

    expect(emitProjectDeleted).toHaveBeenCalledTimes(1);
    expect(emitProjectDeleted).toHaveBeenCalledWith({ projectId });
  });

  it("returns 404 for a project that never existed", async () => {
    const res = await request(app).delete("/api/projects/never-existed").set("Cookie", user.cookie);

    expect(res.status).toBe(404);
  });
});
