import type { ExpressAuthConfig } from "@auth/express";
import GitHub, { type GitHubProfile } from "@auth/express/providers/github";
import { authAdapter } from "@repo/db";
import { env } from "../../config/env.js";

/**
 * Adds the GitHub-identity fields phase-01 §6 requires on `User` that Auth.js's own
 * `AdapterUser`/`User` types don't know about. This is the documented Auth.js pattern
 * for custom profile fields (return them from `profile()`, declare them here so
 * TypeScript accepts the extra properties) — see docs/decisions/phase-01-log.md for
 * the empirical verification that @auth/prisma-adapter forwards them to
 * `prisma.user.create` unchanged.
 */
declare module "@auth/core/types" {
  interface User {
    // bigint in the profile()/adapter/DB context (matches the Prisma `BigInt`
    // column); the session callback below always normalizes it to a string before
    // it reaches session.user, because BigInt has no native JSON representation and
    // `res.json()` throws on one (decided here, per the Prompt 2 instructions, so
    // Prompt 3's routes don't discover this the hard way). Treat
    // `session.user.githubUserId` as always a string.
    githubUserId?: bigint | string;
    githubLogin?: string;
    avatarUrl?: string | null;
  }
}

/**
 * Shared Auth.js configuration — imported by both the ExpressAuth handler
 * (src/routes/auth.routes.ts) and the session helper (src/lib/auth/session.ts) so
 * there is exactly one source of truth for how a session is issued and how one is
 * read back.
 *
 * Boundary compliance (phase-01 §17 step 1): `authAdapter` is a pre-built adapter
 * imported from @repo/db (packages/db/src/auth-adapter.ts) — this file never imports
 * @prisma/client or the generated client itself (Rule B).
 */
export const authConfig: ExpressAuthConfig = {
  adapter: authAdapter,
  // Mounted at app.use("/api/auth/*", ...) in app.ts — set explicitly (rather than
  // relying on ExpressAuth's per-request auto-detection or AUTH_URL's pathname) so
  // getSession() constructs the same URL regardless of call order. See
  // docs/decisions/phase-01-log.md for why this isn't left to the defaults.
  basePath: "/api/auth",
  // AUTH_URL is required (src/lib/config.ts), so trustHost is always warranted here —
  // set explicitly rather than relying on @auth/core's implicit
  // `!!(AUTH_URL ?? ...)` inference (see docs/decisions/phase-01-log.md).
  trustHost: true,
  secret: env.AUTH_SECRET,
  // Auth.js's own sign-in and error pages live on the API origin; the UI lives on
  // another origin entirely in this topology. @auth/core builds these URLs as
  // `${origin}${pages[kind]}` (verified by reading node_modules/@auth/core/index.js),
  // so they must be *paths*, not absolute URLs — src/routes/auth.routes.ts serves both
  // and redirects on to apps/web's /signin, carrying the `error` code through. Without
  // this, denying the GitHub authorization dead-ends on the API origin (phase-01 §14
  // Failure Verification).
  pages: {
    signIn: "/auth/signin",
    error: "/auth/error",
  },
  // Explicit even though @auth/core already defaults to "database" whenever an
  // `adapter` is configured — phase-01 §1/§17/§22 treats this as a binding decision
  // (JWT sessions are explicitly rejected: they can't be revoked), so it's spelled
  // out rather than left to an implicit default a future change could invert.
  session: { strategy: "database" },
  // Cookie flags: httpOnly, secure (only over https — see cookie.js's
  // `useSecureCookies`), sameSite=lax are @auth/core's unconditional defaults for
  // every cookie it sets (verified by reading
  // node_modules/@auth/core/lib/utils/cookie.js) — phase-01 §4/§13's requirement is
  // met without a custom `cookies` override.
  callbacks: {
    // Without this override, @auth/core's *default* session callback
    // (node_modules/@auth/core/lib/init.js) strips everything down to
    // {name, email, image, expires} — `user.id` (and every custom field above) is
    // silently dropped. requireSession() below depends on `session.user.id`, so this
    // isn't optional polish — verified by reading the default callback's source, not
    // assumed. `expires` must be converted to an ISO string: the database-session
    // callback receives a `Date`, but the public Session type is a string.
    session({ session, user }) {
      const expires: unknown = session.expires;
      return {
        ...session,
        expires: expires instanceof Date ? expires.toISOString() : (expires as string),
        user: {
          ...session.user,
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          // BigInt -> string at the API/DTO boundary (see the module augmentation
          // comment above) — githubUserId never reaches a JSON response as a bigint.
          githubUserId: typeof user.githubUserId === "bigint" ? user.githubUserId.toString() : user.githubUserId,
          githubLogin: user.githubLogin,
          avatarUrl: user.avatarUrl,
        },
      };
    },
  },
  providers: [
    GitHub({
      clientId: env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
      // No `authorization.params.scope` override: @auth/core's built-in GitHub
      // provider already defaults to exactly "read:user user:email" (verified by
      // reading node_modules/@auth/core/providers/github.js) — nothing
      // repository-related, per phase-01 §4/§13.
      profile(profile: GitHubProfile) {
        return {
          id: profile.id.toString(),
          name: profile.name ?? profile.login,
          email: profile.email,
          image: profile.avatar_url,
          // Custom fields phase-01 §6 requires beyond Auth.js's base User shape.
          githubUserId: BigInt(profile.id),
          githubLogin: profile.login,
          avatarUrl: profile.avatar_url,
        };
      },
    }),
  ],
};
