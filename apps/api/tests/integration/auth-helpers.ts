import { randomUUID } from "node:crypto";
import { prisma } from "@repo/db";

/**
 * Seeds a real `User` + `Session` row and hands back the cookie that authenticates as
 * them.
 *
 * Deliberately **not** a stub at the `src/lib/auth/session.ts` boundary: driving the
 * routes with a real cookie means every test in this suite exercises the actual
 * database-session resolution path (`@auth/express` `getSession` → `Session` row →
 * `User` row → the session callback), which is the thing most likely to break. Stubbing
 * `requireSession` would make these tests pass even if session resolution were
 * completely broken. No test contacts GitHub.
 *
 * `githubUserId` is unique per seeded user because the column carries `@unique`; the
 * counter keeps that true across a single file's tests without coordinating values by
 * hand.
 */

let seq = 0;

export interface SeededUser {
  id: string;
  githubLogin: string;
  /** Ready to pass to supertest's `.set("Cookie", …)`. */
  cookie: string;
}

export async function seedSignedInUser(
  githubLogin: string,
): Promise<SeededUser> {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      githubUserId: BigInt(1_000_000 + seq),
      githubLogin,
      email: `${githubLogin}-${seq}@example.com`,
      name: githubLogin,
    },
  });

  const sessionToken = randomUUID();
  await prisma.session.create({
    data: {
      sessionToken,
      userId: user.id,
      expires: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  // The non-`__Secure-` name is what @auth/core uses over plain http, which is what
  // supertest speaks (verified in tests/integration/auth.test.ts).
  return {
    id: user.id,
    githubLogin,
    cookie: `authjs.session-token=${sessionToken}`,
  };
}

/** Signs the user out the way Auth.js does — by removing the session row — so the old
 * cookie can be replayed to prove it no longer authenticates (phase-01 §15). */
export async function invalidateSessionsFor(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}
