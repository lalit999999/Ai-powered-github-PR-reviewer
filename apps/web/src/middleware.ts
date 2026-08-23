import { NextResponse, type NextRequest } from "next/server";

/**
 * Server-side protected-route enforcement, layer 1 of 2 (phase-01 §3/§17 step 10).
 *
 * This runs on the Edge runtime, where a database lookup is not available, so it does
 * the one thing it usefully can: turn away requests that carry no session cookie at all
 * before they cost a render. It is a **filter, not the authorization decision** — a
 * forged or expired cookie sails through here and is rejected by
 * `src/app/(app)/layout.tsx`, which resolves the session against the API/database. Both
 * layers are server-side; there is no client-side-only check anywhere.
 *
 * Auth.js names the session cookie `authjs.session-token` over http and
 * `__Secure-authjs.session-token` over https (from @auth/core's
 * `useSecureCookies` default), so both are accepted.
 *
 * The matcher deliberately covers only the authenticated page routes. `apps/web` serves
 * no API routes of its own — the API is a separate origin and answers 401 rather than
 * redirecting, which is what keeps a 401 from turning into a redirect loop (§14).
 */

const SESSION_COOKIE_NAMES = ["authjs.session-token", "__Secure-authjs.session-token"];

export function middleware(request: NextRequest): NextResponse {
  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name));

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
