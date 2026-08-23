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
