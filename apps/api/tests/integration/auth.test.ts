import { authAdapter, prisma } from "@repo/db";
import type { Request } from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import app from "../../src/app.js";
import { UnauthenticatedError } from "../../src/lib/errors.js";
import { getCurrentSession, requireSession } from "../../src/lib/auth/session.js";
import { getTraceContext, runWithTraceContext } from "@repo/observability";
import { resetDatabase } from "./db-helpers.js";

/** Only `req.protocol` and `req.headers.cookie` are read by @auth/express's
 * getSession (verified by reading its source) — this is enough to drive
 * requireSession()/getCurrentSession() without standing up a real HTTP request. */
function fakeRequest(cookieHeader?: string): Request {
  return {
    protocol: "http",
    headers: { cookie: cookieHeader },
  } as unknown as Request;
}

async function seedUser(overrides: Partial<{ githubUserId: bigint; githubLogin: string }> = {}) {
  return prisma.user.create({
    data: {
      githubUserId: overrides.githubUserId ?? 555001n,
      githubLogin: overrides.githubLogin ?? "octocat",
      email: "octocat@example.com",
    },
  });
}

async function seedSession(userId: string, opts: { token?: string; expiresInMs?: number } = {}) {
  const token = opts.token ?? "test-session-token";
  await prisma.session.create({
    data: {
      sessionToken: token,
      userId,
      expires: new Date(Date.now() + (opts.expiresInMs ?? 60_000)),
    },
  });
  return token;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("/api/auth/* route mounting (phase-01 §17 step 1)", () => {
  it("lists github as a configured provider", async () => {
    const res = await request(app).get("/api/auth/providers");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("github");
    expect(res.body.github.type).toBe("oauth");
  });

  it("returns a null session body when signed out", async () => {
    const res = await request(app).get("/api/auth/session");
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});

describe("requireSession (phase-01 §4/§17 step 4)", () => {
  it("throws UnauthenticatedError when there is no session cookie", async () => {
    await expect(requireSession(fakeRequest())).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("throws UnauthenticatedError for an unknown session token — never falls open to a default user", async () => {
    await seedUser();
    await expect(requireSession(fakeRequest("authjs.session-token=does-not-exist"))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("resolves a seeded Session row to the right user, including the custom GitHub fields", async () => {
    const user = await seedUser({ githubUserId: 777002n, githubLogin: "hubot" });
    const token = await seedSession(user.id);

    const session = await requireSession(fakeRequest(`authjs.session-token=${token}`));

    expect(session.user.id).toBe(user.id);
    expect(session.user.githubLogin).toBe("hubot");
    expect(session.user.githubUserId).toBe("777002");
    expect(typeof session.expires).toBe("string");
  });

  it("treats an expired session as signed-out, not as a default user", async () => {
    const user = await seedUser();
    const token = await seedSession(user.id, { expiresInMs: -60_000 });

    await expect(requireSession(fakeRequest(`authjs.session-token=${token}`))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );

    const stillThere = await prisma.session.findUnique({ where: { sessionToken: token } });
    expect(stillThere).toBeNull(); // @auth/core's session action deletes expired sessions on read
  });

  it("extends the trace context with userId so subsequent log lines carry it (phase-01 §20)", async () => {
    const user = await seedUser();
    const token = await seedSession(user.id);

    await runWithTraceContext({ traceId: "trace-auth-test" }, async () => {
      await requireSession(fakeRequest(`authjs.session-token=${token}`));
      expect(getTraceContext()).toMatchObject({ traceId: "trace-auth-test", userId: user.id });
    });
  });

  it("getCurrentSession returns null instead of throwing when signed out", async () => {
    await expect(getCurrentSession(fakeRequest())).resolves.toBeNull();
  });
});

describe("Auth.js Prisma adapter — profile()-field passthrough and upsert behavior (phase-01 §6/§14)", () => {
  it("createUser persists the custom githubUserId/githubLogin/avatarUrl fields returned by profile()", async () => {
    // Mirrors exactly what GitHub's profile() callback in src/lib/auth/config.ts
    // returns — verifies empirically (not assumed) that @auth/prisma-adapter forwards
    // extra profile fields straight through to prisma.user.create.
    const created = await authAdapter.createUser!({
      id: "ignored-adapter-generates-its-own",
      name: "Hu Bot",
      email: "hubot@example.com",
      image: "https://avatars.example.com/hubot.png",
      githubUserId: 909003n,
      githubLogin: "hubot",
      avatarUrl: "https://avatars.example.com/hubot.png",
      emailVerified: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(created.id).toBeTruthy();
    const row = await prisma.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.githubUserId).toBe(909003n);
    expect(row.githubLogin).toBe("hubot");
    expect(row.avatarUrl).toBe("https://avatars.example.com/hubot.png");
    expect(row.image).toBe("https://avatars.example.com/hubot.png");
  });

  it("repeated sign-in for the same GitHub identity resolves to exactly one User row", async () => {
    // Simulates @auth/core's handleLoginOrRegister OAuth path directly (adapter-level,
    // no real GitHub network call — the documented fallback in the Prompt 2
    // instructions since driving real OAuth in CI isn't possible).
    const provider = "github";
    const providerAccountId = "424004";

    const firstLookup = await authAdapter.getUserByAccount!({ provider, providerAccountId });
    expect(firstLookup).toBeNull();

    const user = await authAdapter.createUser!({
      id: "ignored",
      name: "Once",
      email: "once@example.com",
      githubUserId: 424004n,
      githubLogin: "once",
      emailVerified: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await authAdapter.linkAccount!({
      userId: user.id,
      type: "oauth",
      provider,
      providerAccountId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Second sign-in: handleLoginOrRegister looks up by (provider, providerAccountId)
    // first and, on a hit, never calls createUser again.
    const secondLookup = await authAdapter.getUserByAccount!({ provider, providerAccountId });
    expect(secondLookup?.id).toBe(user.id);

    const userCount = await prisma.user.count({ where: { githubUserId: 424004n } });
    expect(userCount).toBe(1);
  });
});
