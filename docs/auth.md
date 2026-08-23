# Authentication & Tenancy

How a user signs in, what a session is, and — the part every later phase depends on —
how a route decides whether the caller may touch a resource.

Written for reuse: **Phase 02 onward extends `requireTenantAccess`, it does not write
its own ownership check.** If you are adding a route and reaching for
`where: { userId }` in a handler, this document is the thing you are looking for.

---

## 1. The two credentials, never conflated

| | OAuth session (this phase) | GitHub App installation (Phase 02) |
|---|---|---|
| Answers | *Who is logged in?* | *What repository data may we read?* |
| Obtained by | GitHub OAuth sign-in | Installing the GitHub App on an org/account |
| Scopes | `read:user`, `user:email` — nothing repository-related | Repository contents, PRs, checks |
| Stored as | `User` + `Session` rows | `GithubInstallation` rows (empty until Phase 02) |

The OAuth token is **never** used to call repository-scoped GitHub APIs (phase-01 §13,
plan.md Assumption A3). They are separate credentials with separate lifetimes; treating
the session as repository authority is the specific design mistake this split exists to
prevent.

---

## 2. Sign-in flow

Auth.js (`@auth/express` v0.12 / `@auth/core` v0.41 — v5-era, so `AUTH_URL`, not
`NEXTAUTH_URL`) is mounted inside **`apps/api`**, not `apps/web`. The UI is a pure
frontend; the callback lands on the API origin.

```
apps/web /signin
    │  SignInButton: GET  {API}/api/auth/csrf      (sets the csrf cookie)
    │                POST {API}/api/auth/signin/github  { csrfToken, callbackUrl }
    ▼
GitHub OAuth consent
    │
    ▼
{API}/api/auth/callback/github?code=…
    │  @auth/core exchanges the code, runs the provider's profile() callback,
    │  the Prisma adapter creates or finds the User, and creates a Session row
    ▼
redirect callback → apps/web /dashboard          (session cookie set)
```

Three pieces of that are non-obvious and are wired deliberately:

- **`profile()` maps the GitHub identity onto the `User` columns.** `@auth/prisma-adapter`
  forwards whatever `profile()` returns straight to `prisma.user.create`, so
  `githubUserId`/`githubLogin`/`avatarUrl` land without a backfill hook. `githubUserId`
  — not `email` — is the stable identity key, because a GitHub email can change
  (phase-01 §22).
- **`callbacks.session` re-attaches `user.id`.** @auth/core's *default* session callback
  reduces the session to `{name, email, image, expires}` and drops the id. Every
  authenticated route depends on `session.user.id`, so this override is load-bearing,
  not decoration.
- **`callbacks.redirect` allow-lists the frontend origin.** The default resolves relative
  callback URLs against the *API* origin, which would land a successful sign-in on the
  API instead of the UI. The override accepts the frontend origin and the API's own
  origin and falls back to the frontend root — a permissive version of this callback is
  an open redirect.

### Error and sign-in pages live on the frontend

@auth/core builds its page URLs as `` `${apiOrigin}${config.pages[kind]}` ``, so
`pages.*` entries must be **paths on the API origin** and cannot point at `apps/web`
directly. `authConfig.pages` therefore names two bridge routes —
`GET /auth/signin` and `GET /auth/error` in `apps/api` — which redirect on to
`{FRONTEND_URL}/signin`, carrying `?error=` through. A denied or revoked authorization
ends on the app's own sign-in screen with a rendered message, not on a dead end
(phase-01 §14 Failure Verification).

### Sign-out

`POST {API}/api/auth/signout` (csrf-protected, same shape as sign-in) **deletes the
`Session` row**. The old cookie stops authenticating immediately — the whole reason for
database sessions over JWTs (phase-01 §1/§22). Clearing the cookie client-side is not
sign-out; the server has to refuse it.

---

## 3. The session model

`session: { strategy: "database" }` with the Prisma adapter. A session is a `Session`
row (`sessionToken`, `userId`, `expires`) plus a cookie holding the token.

**Cookie flags** come from @auth/core's unconditional defaults and are asserted on real
`Set-Cookie` headers in `tests/integration/auth-cookies.test.ts`:

| Flag | Value | Note |
|---|---|---|
| `httpOnly` | always | |
| `sameSite` | `Lax` | see the same-site deployment constraint in `docs/deployment.md` |
| `secure` | follows the request scheme | on for https, off for `http://localhost`; `app.set("trust proxy", true)` is what makes this correct behind a TLS-terminating load balancer |
| name | `authjs.session-token` / `__Secure-authjs.session-token` | the prefix appears with `secure` |

### Reading a session

```ts
import { requireSession } from "../lib/auth/session.js";

const session = await requireSession(req); // AuthenticatedSession — user.id guaranteed
```

`requireSession` throws `UnauthenticatedError` (401) for a missing, unknown, or expired
session. It **never falls open to a default user** (phase-01 §4). It also calls
`setTraceUserId`, so every log line for the rest of the request carries `userId`
automatically — no threading required.

`getCurrentSession(req)` is the non-throwing variant, for the rare caller that wants to
branch on signed-in-ness rather than require it.

---

## 4. `requireTenantAccess` — the shared authorization chokepoint

> **This is the only way a handler decides ownership. There is no handler-local
> ownership check anywhere in this codebase, and adding one is a defect.**
> (phase-01 §13, plan.md §34.2)

```ts
import { requireTenantAccess } from "../lib/auth/tenant-access.js";

export async function getProject(req: Request, res: Response): Promise<void> {
  const session = await requireSession(req);                          // 1. authenticate
  const { projectId } = parseOrThrow(projectIdParamSchema, req.params);
  const tenant = await requireTenantAccess(session, { projectId });   // 2. resolve tenancy
  const detail = await projectService.getProjectDetail(tenant);       // 3. delegate
  res.status(200).json(detail);
}
```

```ts
requireTenantAccess(
  session: AuthenticatedSession,
  resource: { projectId?: string },      // Phase 02 adds repositoryId?, Phase 07 reviewId?
  options?: { allowDeleted?: boolean }
): Promise<TenantContext>                // { userId, projectId }
```

### The four rules

1. **Every failure is a 404.** Missing, soft-deleted, and foreign all return the same
   404 with the same body. phase-01 §7 lists a 403 for "not owner", but §12 says a 403
   that reveals a resource *exists* is itself an information leak — §12 wins, because a
   403 turns id-guessing into tenant enumeration. `ForbiddenError` stays in the error
   hierarchy for later resource types where the caller provably already knows the
   resource exists.
2. **The reason survives only in the log.** A denied check logs at `warn`:
   `{ msg: "tenant access denied", projectId, userId, reason: "FOREIGN" | "MISSING" | "DELETED" }`,
   component `auth.tenant-access`. A spike in `FOREIGN` is an authorization bug or a
   probe; `MISSING`/`DELETED` is usually a client holding a stale id. Every later
   phase's tenancy check follows this exact convention (phase-01 §20).
3. **One query resolves the whole chain.** Every authenticated route pays this cost, so
   it stays at one read, through `project.repository` — never raw Prisma (Rule B).
4. **It sets `projectId` on the trace context.** From the moment tenancy resolves, every
   log line in the request — including the request-completion line — carries
   `traceId`, `userId`, and `projectId` (phase-01 §16/§20).

### `allowDeleted`

Exactly one caller sets it: `DELETE /api/projects/:id`. phase-01 §4 requires the delete
to be idempotent, which is impossible if the tenancy check 404s on the second call.
Ownership is still enforced — a *foreign* soft-deleted project is still 404 — and every
read path leaves it off, so soft-deleted projects stay invisible everywhere else.

### How to extend it in a later phase

Add a resolution branch, do not add a second function:

```ts
// Phase 02, sketch
export interface TenantResource {
  projectId?: string;
  repositoryId?: string;   // ← new
}
export interface TenantContext extends OwnerContext {
  projectId: string;
  repositoryId?: string;   // ← new
}
```

Resolve `repositoryId` → `repository.projectId` → `project.userId` in **one** query
(a single join in the repositories module's `*.repository.ts`), reuse the same `denied()` warn line
with the same reason vocabulary, and keep returning 404 for every failure. Then copy
`tests/integration/cross-tenant.test.ts`'s pattern for the new resource type — that file
is written as a template and says so.

---

## 5. The layering this enforces

| Layer | Rule |
|---|---|
| Route handler | authenticate → `requireTenantAccess` → `parseOrThrow` → delegate. No business logic, no ownership query, no raw input parsing. |
| Service | Takes the tenant context as a **required first argument** — `OwnerContext` for collection operations, `TenantContext` for a specific resource. Never optional, never derived from a request. |
| Repository | Every `where` carries the owner scope. Every read excludes `deletedAt != null` unless the function name says otherwise. Only `*.repository.ts` (and `packages/db/**`) may import Prisma. |

Row-Level Security is the eventual backstop for a missing `where` (plan.md §34.2), and
is deliberately deferred to a post-MVP phase. Until then, the service-layer scoping above
*is* the control, which is why the cross-tenant test is not optional.

---

## 6. Protected routes in `apps/web`

Two server-side layers, no client-side-only check:

1. `src/proxy.ts` (Next 16's renamed `middleware` convention) — Edge-runtime filter that
   redirects to `/signin` when no session cookie is present at all. Cheap, and cannot
   validate.
2. `src/app/(app)/layout.tsx` — **the authoritative check**. Resolves the session against
   the API/database and `redirect("/signin")`s when there is none. An expired or forged
   cookie is rejected here.

API routes never redirect: `apps/api` answers **401** for an unauthenticated request, so
an expired session in a client fetch surfaces as an error the caller can handle rather
than an HTML sign-in page (phase-01 §14 Failure Verification).

---

## 7. Environment

`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `AUTH_SECRET`, `AUTH_URL` —
all required, all validated at boot. `AUTH_URL` points at **`apps/api`**, and its
registered GitHub callback URL is `$AUTH_URL/api/auth/callback/github`. Getting that
wrong per environment is the single most common failure in this phase; see
`docs/deployment.md` before debugging anything else.
