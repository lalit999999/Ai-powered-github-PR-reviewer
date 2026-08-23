# Phase 01 — Decision Log

Records the judgment calls made while implementing the Phase 01 **foundation**
(authentication + the field-complete data model). Prompt 3 builds the project feature,
authorization, and UI on top of this; entries here are binding for that work.

Phase 00's remaining items (health route, Inngest wiring, frontend shell, CI, staging
config) were completed in the same pass — decisions belonging to those are appended to
`phase-00-log.md` §13 onward, not here.

## 1. Installed versions — read, not assumed

Everything below was verified by reading the installed packages' own source and type
definitions under `node_modules/`, not from memory or the published docs (which, for
several of these, are wrong or out of date for the installed version).

| Package | Version | Why this one |
|---|---|---|
| `@auth/express` | 0.12.3 | Auth.js's Express integration. `next-auth` is Next.js-only and doesn't fit this repo's Express-backend topology (phase-00-log §1) |
| `@auth/core` | 0.41.3 | Pulled in by both packages below; the actual implementation |
| `@auth/prisma-adapter` | 2.11.3 | Official Prisma adapter, for DB-backed sessions |
| `inngest` | 4.18.1 | Latest; SDK for the worker |
| `next-themes` | 0.4.6 | Theme provider for the frontend shell |

**This is Auth.js v5-era, not v4.** There is no `getServerSession`, no `NEXTAUTH_URL`.
`@auth/core` reads `AUTH_URL` (falling back to `NEXTAUTH_URL` only inside
`createActionURL`), so `AUTH_URL` is the name used throughout — matching the phase
document's "AUTH_URL (or NEXTAUTH_URL, per the Auth.js version in use)".

`@auth/express` self-describes as experimental ("the API _will_ change in the future").
Recorded so a future upgrade is treated as a real migration, not a patch bump.

## 2. Auth.js adapter ↔ phase-01 §6 `User` reconciliation

Phase-01 §6 specifies `User` with `githubUserId`/`githubLogin`/`email`/`avatarUrl`/`plan`.
The Prisma adapter needs its own columns. Reconciled **additively** — every field the
phase document specifies is present and unchanged; the adapter's needs were added
alongside:

| Column | Origin | Note |
|---|---|---|
| `githubUserId`, `githubLogin`, `avatarUrl`, `plan` | phase-01 §6 | unchanged |
| `email` | both | shared; see the `@unique` note below |
| `name`, `image`, `emailVerified` | adapter | additive |

Three consequences worth stating explicitly:

- **`email` carries `@unique`, which phase-01 §6 does not specify.** The adapter's
  `getUserByEmail` does `p.user.findUnique({ where: { email } })`, which Prisma only
  generates for a unique field. `@auth/core`'s `handleLoginOrRegister` calls it on every
  OAuth sign-in to detect the "same email, different provider account" case, so without
  the constraint the adapter simply doesn't compile against the generated client. This
  is a deviation from the literal field list, forced by the adapter, and it is
  *stricter* than the document, not looser. `email` stays nullable — GitHub accounts
  with no public email are still creatable.
- **`image` duplicates `avatarUrl`.** Both are populated from `profile.avatar_url` in
  the same `profile()` callback, so they cannot diverge. Kept rather than collapsed:
  dropping `avatarUrl` would contradict the phase document, and dropping `image` would
  break the adapter's expectations.
- **`Authenticator` (WebAuthn) is deliberately omitted.** The adapter exposes
  `createAuthenticator`/`getAuthenticator`/etc., but `@auth/core` only invokes them when
  a WebAuthn provider is configured, which this phase never does. Adding the table would
  be schema creep for a code path that cannot execute.

### How the custom fields actually reach the database — verified, not assumed

`@auth/prisma-adapter`'s `createUser` is `({ id, ...data }) => p.user.create(stripUndefined(data))`
— it forwards **whatever object it is handed** straight to Prisma, minus `id`. And
`@auth/core`'s `handleLoginOrRegister` calls `createUser({ ...profile, emailVerified: null })`,
where `profile` is the return value of the provider's `profile()` callback.

So mapping the GitHub profile in `profile()` is sufficient; **no `createUser`/`signIn`
event backfill is needed.** The prompt asked for a backfill only if the direct approach
didn't work — it does. Proven by an integration test that calls
`authAdapter.createUser()` with exactly the shape `profile()` returns and asserts the
columns landed (`tests/integration/auth.test.ts`).

TypeScript needs a `declare module "@auth/core/types"` augmentation for the extra
fields, since `User` doesn't know about them. That lives in `src/lib/auth/config.ts`.

## 3. The default `session` callback silently drops `user.id` — overridden

`@auth/core`'s **default** session callback (`node_modules/@auth/core/lib/init.js`)
reduces the session to `{ user: { name, email, image }, expires }`. **`user.id` is not
in that list.** Since `requireSession()` depends on `session.user.id`, relying on the
default would have produced a session object that looks fine and authenticates nobody.

`authConfig.callbacks.session` therefore explicitly re-attaches `id` and the GitHub
identity fields. Found by reading the default callback's source, not by debugging a
failure later.

The callback also normalizes `expires`: the database-session path passes a `Date`, while
the public `Session` type declares an ISO string.

## 4. BigInt serialization — resolved at the API/DTO boundary

`User.githubUserId` is `BigInt` (phase-01 §6). `JSON.stringify` throws on a bigint, so
`res.json()` on any DTO containing one is a runtime 500.

**Decision, binding for Prompt 3:** convert to `string` at the boundary. The
`session` callback does this conversion, so `session.user.githubUserId` is *always* a
string; the module augmentation types it `bigint | string` to reflect that it is a
bigint in the DB/adapter context and a string once it reaches a response. No global
`BigInt.prototype.toJSON` monkey-patch — that fixes the symptom invisibly and makes the
type lie about what a route returns.

Everything else in this phase's schema (ids, slugs) is already a string, so this is the
only affected field until Phase 02 adds `installationId`/`githubRepoId`, which follow
the same rule.

## 5. Rule B compliance — the adapter is built inside the repository layer

`PrismaAdapter(prisma)` needs a `PrismaClient`, which `apps/api` may not import
(Rule B, phase-00-log §2). Rather than weakening the rule, `packages/db/src/auth-adapter.ts`
constructs the adapter and exports it as `authAdapter`; `apps/api/src/lib/auth/config.ts`
imports that pre-built object and never sees a Prisma type. **No lint rule was modified,
relaxed, or suppressed.** `pnpm lint` passes and all three boundary fixtures still fail
as designed.

## 6. `/api/auth` mount path — `@auth/express`'s documented pattern is broken on Express 5

`@auth/express`'s own docs say `app.use("/auth/*", ExpressAuth(...))`. On the installed
`express@5.2.1` / `path-to-regexp@8.4.2` that pattern **throws at mount time**:
`TypeError: Missing parameter name at index 11` — bare `*` is no longer a valid token.

The obvious fix (`"/api/auth/*splat"`, Express 5's named-wildcard form) mounts, but is
also wrong: `ExpressAuth` computes its own `basePath` per-request as
`req.baseUrl.split(req.params[0])[0]`, and with a wildcard mount Express sets
`req.baseUrl` to the *entire* request path. Measured directly:

| Mount | `req.baseUrl` for `GET /api/auth/callback/github` | computed basePath |
|---|---|---|
| `"/api/auth/*splat"` | `/api/auth/callback/github` | `/api/auth/callback/github` ❌ |
| `"/api/auth"` | `/api/auth` | `/api/auth` ✅ |

A wildcard mount would corrupt every OAuth callback and session URL Auth.js builds.
**A plain prefix mount is what Express 5 actually needs here.** `basePath` is *also* set
explicitly in `authConfig` so `getSession()` (which doesn't go through the Express
router at all) computes the same value.

One benign consequence: setting both `AUTH_URL` and an explicit `basePath` makes
`@auth/core` log `[auth][warn][env-url-basepath-redundant]` on each call. It is
unavoidable — `ExpressAuth` assigns `config.basePath` per request regardless — and
harmless. Noted so it isn't mistaken for a misconfiguration.

`ExpressAuth` is mounted at the top level in `app.ts`, ahead of the `withRoute`-wrapped
feature routes, because it is a complete sub-application (OAuth dance, CSRF, session and
provider endpoints) that renders its own responses, not a single business-logic route.
It is the deliberate exception to "every route uses `withApiRoute`"; every route this
project writes still goes through the wrapper.

`app.set("trust proxy", true)` was added: `@auth/core` derives `useSecureCookies` from
the request protocol, so behind a TLS-terminating proxy the session cookie would
otherwise lose its `secure` flag.

## 7. Session cookie flags — defaults already satisfy §4/§13, so no override

`httpOnly: true`, `sameSite: "lax"`, and `secure: useSecureCookies` are `@auth/core`'s
unconditional defaults for every cookie it sets
(`node_modules/@auth/core/lib/utils/cookie.js`). `useSecureCookies` follows the URL
scheme, so it is on for https and off for `http://localhost` — which is what makes local
dev work at all. Verified by reading the source rather than adding a redundant `cookies`
override that would have to be kept in sync with the library's own defaults.

`session: { strategy: "database" }` is stated explicitly even though `@auth/core`
already defaults to `"database"` whenever an adapter is present: phase-01 §1/§22 treats
this as binding (JWT sessions can't be revoked), so it should not rest on an implicit
default a future change could silently invert.

## 8. Clerk removed — the phase-00-log §5 conflict, resolved

`phase-00-log.md` §5 flagged that `apps/web` shipped Clerk while the phase documents
bind the project to Auth.js (`plan.md` §35.1, phase-00 §1, phase-01 §1), and deferred the
call to this phase. Resolved in favor of the phase documents, which are authoritative:

- deleted `apps/web/src/middleware.ts` (`clerkMiddleware`),
- removed `ClerkProvider` from the root layout,
- removed the `@clerk/nextjs` dependency,
- replaced `apps/web/.env.local`'s Clerk keys with `NEXT_PUBLIC_API_URL`,
- removed `CLERK_SECRET_KEY` from `.env.example`.

The user's binding instruction recorded in phase-00-log §1 was about **repository
topology** (keep the `apps/*` split), not about the auth provider, so this does not
contradict it. No Clerk code remains.

## 9. `apps/worker` — created here, with a deliberately duplicated logger/tracer

phase-00-log §1 mapped `src/inngest/**` onto `apps/worker`, which had no `package.json`
until now. Structure follows plan.md §44 / phase-00 §18: `src/inngest/{client,events}.ts`,
`src/inngest/middleware/logging.ts`, `src/inngest/functions/noop.ts`, served at
`/api/inngest` by a small Express app on `WORKER_PORT` (default 4500).

`lib/{logger,tracing,config}.ts` are **copied** from `apps/api`, not shared. `apps/api`
uses NodeNext relative imports with no path alias (phase-00-log §8) and exports nothing
as a package, so sharing would mean creating a `packages/shared` workspace package —
real structural work for one diagnostic function. Phase 03, when the worker gets actual
functions, is the right time. Recorded so the duplication reads as a deliberate,
time-boxed choice rather than an oversight. **If the log envelope changes, both copies
must change** — they are byte-identical today.

The root ESLint config's Rule C glob was `apps/worker/src/functions/**` — a path that
was guessed before the directory existed and matches nothing. Corrected to
`apps/worker/src/inngest/functions/**`. The rule was never satisfiable as written; this
makes it real.

## 10. Inngest tracing middleware needs *two* hooks, not one

`wrapFunctionHandler` is Inngest's documented AsyncLocalStorage hook. It works for code
in the function body — but the context is **`undefined` inside a `step.run()` callback**.
Confirmed by instrumenting the middleware and the step handler and reading the output:

```
DEBUG top of handler,          ctx= { traceId: '01M0R8323W7…' }
DEBUG inside step.run callback, ctx= undefined
```

The likely cause is Inngest's checkpointing (`ClientOptions.checkpointing` defaults to
`true`) invoking step callbacks from a context that isn't a causally-linked continuation
of the request that entered `wrapFunctionHandler`. Since step callbacks are exactly where
function code logs, the naive one-hook implementation would have produced `traceId`-less
log lines — the specific failure phase-00 §22 calls the most expensive to retrofit.

Fixed by also implementing `wrapStepHandler` and generating the traceId **once per
middleware instance**. Inngest constructs middleware fresh per request ("so that
middleware can safely use `this` for request-scoped state" — the SDK's own doc comment),
so both hooks share one id. Verified end-to-end against a real Dev Server: the emitted
line carries the same `traceId` inside and outside the step.

Tenancy middleware is not built — phase-00 §8 defers it until tenancy exists.

## 11. Prisma 7 tooling differences encountered

- `prisma migrate dev` **cannot run non-interactively** (it errors out rather than
  prompting), so the migration was produced with
  `prisma migrate diff --from-config-datasource --to-schema … --script` and applied with
  `migrate deploy`. `--from-url` was removed in Prisma 7; the current flags are
  `--from-config-datasource` / `--to-schema`.
- The generated SQL is a genuinely **destructive** migration (`ALTER TABLE … ADD COLUMN
  … NOT NULL` against `User`/`Project`), which is correct and intended per phase-01 §6.
  Confirmed both tables were empty (`SELECT count(*)` = 0) before applying — no data was
  at risk, and no data-preserving contortion was invented to avoid it.
- `packages/db/.env` still points at an external Neon instance (phase-00-log §12's
  safety note). **Every** Prisma command in this work explicitly overrode `DATABASE_URL`
  to the local docker-compose Postgres. That file was not modified. This hazard is
  unchanged and still applies to `pnpm db:migrate`/`db:deploy` run without an override.

## 12. Testing notes

- **`vi.spyOn(prisma, "$queryRaw")` corrupts the client permanently.** Under Prisma 7's
  driver-adapter client, `vi.restoreAllMocks()` does not restore it — the method is
  left as `undefined`, so every later test sharing the singleton fails with
  `prisma.$queryRaw is not a function` (and the integration config runs files serially
  against one client). Reproduced in isolation before changing anything. The
  `/api/health` 503 test therefore spies one layer up, on
  `health.repository.pingDatabase` — a plain module export, which restores correctly and
  exercises the same failure path. **Do not spy on Prisma client methods in this repo.**
- **`GET /api/auth/session` returns `null`, not `{}`, when signed out** — `@auth/express`'s
  `getSession` returns `null` for an empty body. An assertion written the other way was
  corrected against observed behavior.
- **Real OAuth is never driven in CI.** Per the prompt's allowance, the
  one-user-per-GitHub-identity guarantee is tested at the adapter level: `getUserByAccount`
  → `createUser` → `linkAccount`, then a second `getUserByAccount` that resolves to the
  same row without a second create — which is exactly the branch `handleLoginOrRegister`
  takes on a repeat sign-in. No test contacts GitHub.

### Prompt 1 tests changed (and why)

Only tests genuinely invalidated by this phase's schema/config changes were touched.
None were deleted.

| Test | Change | Why |
|---|---|---|
| `db.test.ts` "no premature schema creep" | Rewritten against the field-complete column list | Phase 01 §6 supersedes the placeholder shape *by design*; the assertion was correct for Phase 00 and is now correct for Phase 01. Kept (not deleted) so schema creep is still caught |
| `db.test.ts` round-trip | Now supplies the required `githubUserId`/`githubLogin`/`name`/`slug` | The placeholder models had no required fields; the field-complete ones do |
| `db-helpers.ts` `resetDatabase` | Truncates the four new tables too | Otherwise adapter rows leak between tests |
| `config.test.ts` | `VALID_ENV` extended with the four Phase 01 vars; empty-env assertion count 4 → 8 | The config schema gained four required variables (phase-01 §19) |

## 13. Outstanding — requires human action

Cannot be done from here; both are called out in `docs/deployment.md`:

- **No staging deployment was performed.** The configuration and documentation are
  committed; the deploy itself, and confirming `/api/health` is reachable there, are
  manual.
- **No real GitHub OAuth App exists.** Local `.env` uses placeholder client
  id/secret — enough to boot and to exercise every non-network path, not enough for a
  real sign-in. Creating the app and registering
  `$AUTH_URL/api/auth/callback/github` per environment is manual, and per phase-01 §22
  is the single most likely thing to be wrong in a new environment.

---

# Phase 01 completion (Prompt 3)

Prompt 2 built the authentication foundation and the field-complete schema. This section
records the decisions made building the authorization chokepoint, the project feature,
the UI, and the adversarial tests on top of it.

**Verification of Prompt 2's output before starting anything:** `pnpm typecheck`,
`pnpm lint`, `pnpm test:unit` (7 files / 52 tests), `pnpm test:integration` (3 files /
19 tests), `pnpm build`, and `prisma migrate status` all passed unchanged against the
committed tree. Nothing was broken and nothing needed fixing before this work began.

## 14. `packages/shared` created — for a contract, not for convenience

`project/deleted` has a **producer in `apps/api`** and a **consumer in `apps/worker`**.
The phase document puts the event registry at `src/inngest/events.ts`, which
phase-00-log §1 maps onto `apps/worker`. Duplicating the name and payload in both
deployables would have made the one thing phase-01 §8 exists to guarantee — a stable,
agreed shape — the one thing nothing enforces.

`packages/shared` (`@repo/shared`) was therefore created, holding **only type-level
contracts and constants, with no runtime dependencies**. `apps/worker/src/inngest/events.ts`
builds its Inngest trigger from it; `apps/api/src/inngest/emit.ts` sends against it.

phase-00-log §9 deferred `packages/shared` to Phase 03 — but that was about *sharing a
duplicated logger*, which is convenience. A cross-deployable contract is a different
and better reason, and the deferral is not extended to the logger: `apps/worker`'s
`lib/{logger,tracing,config}.ts` remain byte-identical copies, exactly as recorded there.

## 15. Inngest v4 has no client-level `schemas` option

`EventSchemas` / `new EventSchemas().fromRecord<Events>()` is the v3 API and **does not
exist in the installed inngest@4.18.1** — verified by reading the package's own
`index.d.ts` export list and `ClientOptions` (which has no `schemas` field), not from
memory or the published docs. v4 types events per-event via
`eventType(name, { schema })` with a Standard Schema.

`staticSchema<T>()` is used rather than a Zod schema: this is a **type contract, not an
input-validation boundary** (the API's Zod schemas are that), and its runtime validator
is a documented pass-through. `ProjectDeletedData` is a `type`, not an `interface`,
because only a type alias gets the implicit index signature that
`staticSchema<T extends Record<string, unknown>>` requires.

`apps/api` gets its own send-only client with a distinct app id (`gitprreviewer-api`)
rather than sharing the worker's. `INNGEST_EVENT_KEY` was already required by apps/api's
config schema in Phase 00, which anticipated exactly this.

## 16. The 403/404 contradiction in the phase document — resolved as 404

phase-01 §7 lists `403 not owner` and `404 not found` as distinct outcomes for
`GET`/`DELETE /api/projects/:id`. §12 says a 403 that reveals a resource *exists* but
isn't yours is itself an information leak, and that both render as 404.

**Resolved in favor of §12, and documented at the decision point** (the doc comment on
`requireTenantAccess`, `docs/auth.md` §4, and a unit test that asserts a foreign project
and a nonexistent one produce byte-identical envelopes):

> Missing, soft-deleted, and foreign projects all return **404**. The distinction is
> preserved only in the `warn` log line, as `reason: "MISSING" | "FOREIGN" | "DELETED"`.

§12 wins because it is the stronger security property: a 403 turns id-guessing into
tenant enumeration. `ForbiddenError` stays in the error hierarchy unused — later phases
have resource types where the caller provably already knows the resource exists, and 403
is the honest answer there.

Stated rather than silently chosen, per the prompt's instruction on document conflicts.

## 17. `allowDeleted` — the option that makes DELETE idempotent

Two phase-01 requirements collide: §7/§11 say a soft-deleted project is not found, and
§4 Reliability says "deleting an already-deleted project returns success, not an error."
If the tenancy check 404s on soft-deleted projects unconditionally, the second DELETE
can never reach the service.

`requireTenantAccess(session, resource, { allowDeleted: true })` resolves it — a third
parameter, so the `resource` argument's shape stays open for Phase 02's `repositoryId`
exactly as the prompt requires. Exactly one caller sets it (the delete route).
Ownership is unaffected: a *foreign* soft-deleted project is still 404, which is asserted
in both the unit and cross-tenant suites.

## 18. One deliberately owner-unscoped repository query, and why

The repository rule is "every query is scoped by `userId`". `findOwnershipById` breaks
it on purpose, and is the only function that does.

A `where: { id, userId }` lookup answers yes/no — which would make "not yours" and
"doesn't exist" indistinguishable *in the logs*, and §20 requires the warn line to
distinguish them. So the tenancy resolver reads `{ id, userId, deletedAt }` by id alone,
in **one query** (plan.md §34.2), and decides in code. Nothing leaks: the row never
leaves the tenancy check, and the caller-visible answer is 404 either way.

`findSlugsForUserByPrefix` is the other named exception — to the *exclude-deleted* rule,
not the owner-scope rule. `@@unique([userId, slug])` has no `deletedAt` in it, so a
soft-deleted project still owns its slug; a uniqueness probe that ignored deleted rows
would propose a slug the database then rejects. Consequence, verified by test: reusing a
deleted project's name yields `name-2`, not `name`.

## 19. Slug retry — deterministic suffix, exactly one attempt, measured under contention

`slugify` → try → on `P2002`, query the user's `base%` slugs → `base-(max+1)` → try once
more → 409. Not a loop (§12).

The repository translates `P2002` into `{ ok: false, reason: "SLUG_TAKEN" }` rather than
letting a Prisma error code reach the service — the retry policy is business logic and
should not have to know what Prisma's error shape looks like.

Concurrency behavior is asserted against a real Postgres, not reasoned about: two
simultaneous identical-name creates produce two distinct slugs; five produce a mix of
201s and clean 409s with no duplicate slug and no 500. That is the specified outcome —
with enough contention the single retry *should* lose, and 409 is the correct answer
rather than a third attempt.

## 20. `project/deleted` is emitted without being awaited — measured, not assumed

First implementation awaited `emitProjectDeleted` inside the request. Measured against
the dev server with the placeholder `INNGEST_EVENT_KEY`:

| | `DELETE /api/projects/:id` |
|---|---|
| awaiting the emit | **5172 ms** (Inngest SDK retry/backoff on `401 Event key not found`) |
| not awaiting | **38 ms** |

Coupling a user-facing mutation's latency to a notification channel that has **no
consumers in this phase** is the wrong trade, and `202 Accepted` already means "accepted,
work continues". The emit is therefore fire-and-forget:

- `emitProjectDeleted` catches and logs its own failures at `error`, so it can never
  surface as an unhandled rejection;
- the trace context survives into the continuation — the late failure line still carries
  `traceId`, `userId`, and `projectId` (verified in the server log);
- it fires **only on an actual ACTIVE → SOFT_DELETED transition**. An event named for a
  state change should not fire when no state changed; the idempotent repeat call still
  returns 202, it just does not re-announce.

**Phase 03 must revisit this.** Once `cancelOn` handlers make delivery matter, "logged
and dropped" is no longer acceptable — the fix is a transactional outbox, not making the
HTTP response depend on Inngest's availability.

## 21. Auth.js page routes cannot point at another origin — hence the `/auth/*` bridge

`@auth/core` builds its sign-in/error page URLs as
`` `${internalRequest.url.origin}${config.pages[kind]}` `` (read from
`node_modules/@auth/core/index.js`). In this repo's split topology the UI is on a
different origin, so an absolute `pages.error` would concatenate into nonsense.

`authConfig.pages` therefore names two paths on the API origin — `/auth/signin` and
`/auth/error` — served by a small router in `apps/api` that 302s to
`{FRONTEND_URL}/signin`, forwarding `?error=`. Verified end to end:
`GET /auth/error?error=AccessDenied` → `302 http://localhost:3000/signin?error=AccessDenied`.

Only `error` is forwarded, not `callbackUrl` — the sign-in page sets its own destination,
and forwarding an attacker-suppliable URL through a redirect chain is how open redirects
happen.

`pages.signIn` does **not** affect `POST /api/auth/signin/github`; it is read only on the
GET render path (`lib/pages/index.js`), so the OAuth flow is untouched.

### `callbacks.redirect` was also required

@auth/core's default `redirect` callback resolves relative URLs against `AUTH_URL` — the
API origin — so a successful sign-in would have landed on the API, not the UI, and any
absolute frontend URL would have been rejected and replaced by the API origin. The
override allow-lists the frontend origin and the API's own origin and falls back to the
frontend root. A permissive version of this callback is an open redirect, which is why
it is an allow-list rather than a pass-through.

## 22. `middleware.ts` → `proxy.ts` (Next 16's renamed convention)

phase-01 §3 asks for "route-level auth middleware". The installed Next 16.3.2 **deprecates
the `middleware` file convention** and warns on every build ("Please use `proxy` instead");
its own bundled docs (`file-conventions/proxy.md`) give `proxy.ts` exporting `proxy` as
the current form. Written as `proxy.ts` so the build is warning-free and the file matches
the framework version actually installed.

## 23. Protected routes: two server-side layers, and the honest status-code caveat

1. `apps/web/src/proxy.ts` — Edge-runtime **filter**. No database is reachable there, so
   it checks only that a session cookie is present (`authjs.session-token` or
   `__Secure-authjs.session-token`) and 307s to `/signin?callbackUrl=…` otherwise.
2. `apps/web/src/app/(app)/layout.tsx` — the **authoritative check**. Resolves the session
   against the API/database and `redirect("/signin")`s when there is none.

**Measured caveat, recorded because it looks like a hole and is not one.** A request
carrying a *forged or expired* cookie passes layer 1 and is rejected by layer 2 — but the
HTTP status is **200**, not 307, because Next has already flushed the streamed shell by
the time the async layout resolves. What the response actually contains was verified
directly:

```
GET /projects  (forged cookie)  → 200
  occurrences of the signed-in user's project name in the body: 0
  payload contains: NEXT_REDIRECT;replace;/signin;307;
```

and for a foreign project id in the URL:

```
GET /projects/{userA's id}  as user B  → 200
  occurrences of the project name: 0
  payload contains: NEXT_HTTP_ERROR_FALLBACK;404  +  "This page could not be found"
```

So the decision is made on the server and **no protected content is ever produced** — the
navigation instruction is simply delivered in the payload rather than in a status line.
This is Next's documented behavior for `redirect()`/`notFound()` after streaming begins,
not a gap in enforcement.

Making the Edge layer *validate* (rather than filter) would produce a true 307, at the
cost of a second session round-trip on every protected navigation and a hard dependency
on the API being reachable from the Edge runtime — a real deployment coupling. Rejected
for this phase; recorded so the trade is visible rather than discovered.

## 24. No migration was added — and the index question, answered honestly

`@@unique([userId, slug])` and `@@index([userId, deletedAt])` are both present (confirmed
in `pg_indexes` against a database built from scratch by `migrate deploy`). No new
migration was needed and none was written.

"Is the `(userId, deletedAt)` index actually used by the list query?" — measured with
`EXPLAIN ANALYZE`, and the honest answer is more interesting than yes:

| Row distribution | Plan chosen |
|---|---|
| one user owning 5000 of 5004 rows | Seq Scan (correct — the filter matches ~everything) |
| realistic tenant: 40 of 5044 rows | **Index Scan using `Project_userId_slug_key`** |
| same, with 90% of that user's rows soft-deleted | Index Scan using `Project_userId_slug_key` |

The list query **is** index-served at any realistic tenant size — just by the *unique*
index rather than the composite one, because both lead with `userId` and
`deletedAt IS NULL` is not selective enough to justify the wider index. Both indexes are
usable (`pg_stat_user_indexes` records scans on each).

No covering index (`userId, deletedAt, createdAt DESC, id DESC`) was added: the query is
already index-served, pages are capped at 50 rows, and the phase document is explicit
about not adding schema that belongs to a later phase's problems.

## 25. `nextCursor` uses Prisma's `cursor`, with the id as the opaque token

`orderBy: [{ createdAt: "desc" }, { id: "desc" }]` — `id` appended so the sort is total
(two projects created in the same millisecond would otherwise paginate unpredictably).
`take: limit + 1`; the extra row is the existence proof for `nextCursor`, so no second
`count` query and never an empty last page.

A cursor belonging to another user is positionally usable but leaks nothing — `where`
still carries `userId`, so only the *offset* is affected, never the contents.

## 26. Testing decisions

- **Authenticated integration tests drive real cookies, not a stubbed session.**
  `tests/integration/auth-helpers.ts` seeds a real `User` + `Session` row and returns the
  cookie. Stubbing at `src/lib/auth/session.ts` would have let the whole suite pass with
  session resolution completely broken; this way every test exercises the real
  `@auth/express` → `Session` row → `User` row → session-callback path. No test contacts
  GitHub.
- **Cookie flags are asserted off real `Set-Cookie` headers**, via `POST /api/auth/signout`
  — the one action that emits the session cookie without needing GitHub, using the same
  options object that sets it. Both the http case (`HttpOnly`, `SameSite=Lax`, `Path=/`,
  no `Secure`) and the proxied-https case (`__Secure-` name prefix + `Secure`) are covered.
  Asserting against the config object instead would not have caught a change in
  @auth/core's defaults, which is exactly what phase-01-log §7 relies on.
- **`emitProjectDeleted` is mocked in every integration file that deletes**, so CI never
  opens a socket to Inngest. Its own swallow-and-log behavior is unit tested against a
  rejecting client.
- **`vi.mock` + top-level `await import(...)`** is used for the unit tests of
  `tenant-access` and `project.service`: both transitively import `@repo/db` (which throws
  at import time without `DATABASE_URL`) or the config module (which calls
  `process.exit`). Hoisted mocks mean neither is ever loaded. This is also what keeps
  phase-00-log §12's "do not spy on Prisma client methods in this repo" satisfied.
- **No Prompt 1/2 test was modified or deleted.** All 19 pre-existing integration tests
  and all 52 pre-existing unit tests still pass unchanged.

## 27. Repository hygiene note — automatic commits during this work

Something in this environment committed each change as it was made (11 commits between
`0abd67a` and `081b788`); no `git commit` was run as part of this work. One of those
commits (`081b788`) captured `apps/api/seed-tmp.ts`, a throwaway script used only to seed
a session for the manual behavioral pass. It has since been deleted and that deletion is
committed, so the current tree is clean — but the file still exists in history at
`081b788`. Flagged rather than fixed by rewriting history.

## 28. Outstanding — requires human action (unchanged from §13, plus one)

- **No real GitHub sign-in was performed.** `.env` holds placeholder OAuth credentials.
  Every non-network path is exercised (adapter, session resolution, cookie flags,
  sign-out revocation), but the actual OAuth round-trip against GitHub cannot be driven
  from here.
- **Per-environment OAuth callback URL registration** (`$AUTH_URL/api/auth/callback/github`,
  one OAuth App per environment) — phase-01 §14 External Service Verification.
- **No staging deployment**, and therefore no staging sign-in verification.
- **The same-site constraint between `apps/web` and `apps/api`** is new in this phase and
  is a deployment decision: the `sameSite=lax` session cookie is not sent across
  registrable domains, so the two must be subdomains of one domain. Documented in
  `docs/deployment.md`; verifying it holds for the chosen hosts is manual.
