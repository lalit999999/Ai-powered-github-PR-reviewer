import { prisma } from "@repo/db";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import app from "../../src/app.js";
import { seedSignedInUser } from "./auth-helpers.js";
import { resetDatabase } from "./db-helpers.js";

/**
 * Session-cookie flags and sign-out revocation (phase-01 §4/§13/§15).
 *
 * These are asserted against **real `Set-Cookie` headers from the real Auth.js
 * handler**, not against the config object: `httpOnly`/`secure`/`sameSite` come from
 * @auth/core's own defaults (docs/decisions/phase-01-log.md §7 explains why no custom
 * `cookies` override was added), so reading them back off the wire is the only check
 * that would actually catch a regression in those defaults.
 *
 * `POST /api/auth/signout` is the vehicle because it is the one action that emits the
 * session cookie without needing GitHub: it clears the cookie using the *same* options
 * object used to set it.
 */

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Auth.js requires a matching csrf cookie + token on every POST action. */
async function getCsrf(secure: boolean): Promise<{ token: string; cookies: string[] }> {
  const req = request(app).get("/api/auth/csrf");
  if (secure) req.set("X-Forwarded-Proto", "https");
  const res = await req;

  const setCookie = res.headers["set-cookie"] as unknown as string[] | undefined;
  return {
    token: (res.body as { csrfToken: string }).csrfToken,
    cookies: (setCookie ?? []).map((c) => c.split(";")[0] ?? ""),
  };
}

function findSessionCookieHeader(setCookie: string[]): string | undefined {
  return setCookie.find((c) => /^(__Secure-)?authjs\.session-token=/.test(c));
}

describe("session cookie flags (phase-01 §4/§13)", () => {
  it("is httpOnly, sameSite=lax, and path-scoped over http", async () => {
    const user = await seedSignedInUser("cookie-flags");
    const csrf = await getCsrf(false);

    const res = await request(app)
      .post("/api/auth/signout")
      .set("Cookie", [user.cookie, ...csrf.cookies])
      .type("form")
      .send({ csrfToken: csrf.token, callbackUrl: "http://localhost:3000/" });

    const setCookie = res.headers["set-cookie"] as unknown as string[];
    const sessionCookie = findSessionCookieHeader(setCookie);

    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(sessionCookie).toMatch(/Path=\//i);
    // No `Secure` over plain http — that is what makes local development work at all,
    // and is the documented behavior of @auth/core's `useSecureCookies` (which follows
    // the request scheme). The https case is asserted below.
    expect(sessionCookie).not.toMatch(/Secure/i);
  });

  it("adds Secure — and the __Secure- name prefix — behind a TLS-terminating proxy", async () => {
    // `app.set("trust proxy", true)` makes Express honor X-Forwarded-Proto, which is
    // what @auth/core reads to decide `useSecureCookies`. Without the trust-proxy
    // setting a staging deployment behind a load balancer would silently ship a
    // non-`Secure` session cookie (phase-01 §4/§13).
    const user = await seedSignedInUser("cookie-flags-secure");
    const csrf = await getCsrf(true);

    const res = await request(app)
      .post("/api/auth/signout")
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", [`__Secure-${user.cookie}`, ...csrf.cookies])
      .type("form")
      .send({ csrfToken: csrf.token, callbackUrl: "http://localhost:3000/" });

    const setCookie = res.headers["set-cookie"] as unknown as string[];
    const sessionCookie = findSessionCookieHeader(setCookie);

    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/^__Secure-authjs\.session-token=/);
    expect(sessionCookie).toMatch(/Secure/i);
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
  });
});

describe("sign-out invalidates the session (phase-01 §15)", () => {
  it("deletes the Session row so the old cookie no longer authenticates", async () => {
    const user = await seedSignedInUser("signs-out");

    // Authenticates before sign-out.
    await request(app).get("/api/projects").set("Cookie", user.cookie).expect(200);

    const csrf = await getCsrf(false);
    await request(app)
      .post("/api/auth/signout")
      .set("Cookie", [user.cookie, ...csrf.cookies])
      .type("form")
      .send({ csrfToken: csrf.token, callbackUrl: "http://localhost:3000/" });

    // The row is gone — this is the revocability that database sessions exist for
    // (phase-01 §1/§22: a JWT could not be invalidated this way).
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);

    // Replaying the *same* cookie now fails. Clearing it client-side would not have
    // been enough; the server has to refuse it.
    const replay = await request(app).get("/api/projects").set("Cookie", user.cookie);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("UNAUTHENTICATED");
  });
});
