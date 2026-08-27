import { NextResponse, type NextRequest } from "next/server";

/**
 * Server-side protected-route enforcement, layer 1 of 2 (phase-01 §3/§17 step 10).
 *
 * This is what phase-01 §3 calls "route-level auth middleware". Next.js 16 renamed that
 * file convention from `middleware` to `proxy` — the old name still runs but logs a
 * deprecation warning on every build, so the current name is used (verified against the
 * installed Next 16.3.2's own bundled docs, `file-conventions/proxy.md`).
 *
 * It runs on the Edge runtime, where a database lookup is not available, so it does the
 * one thing it usefully can: turn away requests carrying no session cookie at all,
 * before they cost a render. It is a **filter, not the authorization decision** — an
 * expired or forged cookie sails through here and is rejected by
 * `src/app/(app)/layout.tsx`, which resolves the session against the API/database. Both
 * layers are server-side; there is no client-side-only check anywhere in this path.
 *
 * Auth.js names the session cookie `authjs.session-token` over http and
 * `__Secure-authjs.session-token` over https (from @auth/core's `useSecureCookies`
 * default, which follows the URL scheme), so both are accepted.
 *
 * The matcher deliberately covers only the authenticated page routes. `apps/web` serves
 * no API routes of its own — the API is a separate origin and answers 401 rather than
 * redirecting, which is what keeps an API 401 from turning into a redirect loop
 * (phase-01 §14 Failure Verification).
 */

const SESSION_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
];

export function proxy(request: NextRequest): NextResponse {
  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) =>
    request.cookies.has(name),
  );

  if (!hasSessionCookie) {
    const signInUrl = new URL("/signin", request.url);
    signInUrl.searchParams.set("callbackUrl", request.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/projects/:path*"],
};
