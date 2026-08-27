/**
 * Origin of `apps/api`. Separate from `lib/api.ts` because that module imports
 * `next/headers` and is therefore server-only, while client components (the sign-in
 * button, the create dialog) need the same origin to talk to the API directly.
 *
 * `NEXT_PUBLIC_` so it is inlined into the client bundle at build time. The fallback is
 * the local dev port; every deployed environment sets it explicitly (docs/deployment.md).
 */
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
