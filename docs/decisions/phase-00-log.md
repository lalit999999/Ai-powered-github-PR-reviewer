# Phase 00 — Decision Log

This file records every judgment call made while implementing Phase 00 (steps 1–8 / tasks 1–12
per the implementation prompt). Appended to as work proceeds — newest entries at the bottom of
each section they belong to.

## 0. Repository inspection (findings, before any code was written)

The repo is **not** a green-field checkout. It is an existing pnpm + Turborepo monorepo with
real, committed work:

- `apps/web` — Next.js 16 App Router app, Tailwind v4, a large pre-generated shadcn/ui component
  set, and **Clerk** (`@clerk/nextjs`) wired into `middleware.ts`.
- `apps/api` — a separate **Express** server (ESM, `tsx` dev runner) with its own
  `config/env.ts` (Zod-validated `PORT`/`FRONTEND_URL`/`NODE_ENV`), `error.middleware.ts`,
  `not-found.middleware.ts`, and a `health` controller/route.
- `apps/worker` — empty directory, no `package.json` yet. Matches phase-00's statement that the
  worker deployable has nothing to run until Phase 03.
- `packages/db` — a Prisma 7 package (`@repo/db`) using the new `prisma-client` generator and
  `@prisma/adapter-pg` driver adapter (Prisma 7 requires a driver adapter; there is no built-in
  query engine any more). Schema has a `User` model only (`id cuid()`, `email unique`,
  timestamps) and one migration (`20260823184926`) creating just that table. No `Project` model.
- `packages/ai`, `packages/embedings`, `packages/github`, `packages/shared`, `packages/ui`,
  `packages/validation` — empty stub directories, named after Phase 2+ concerns.
- Root `package.json` delegates `dev`/`build`/`lint`/`typecheck` to `turbo`. Root also carries a
  stray `prisma`/`@prisma/client` devDependency and a `prisma.config.ts` pointing at a
  nonexistent root-level `prisma/schema.prisma` — dead scaffolding left over from before
  `packages/db` was split out.
- `.env`/`.env.local` files are correctly gitignored everywhere; only `.env.example` is tracked.
  `.env.example` already lists `DATABASE_URL`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` (phase
  00 vars) plus `REDIS_URL`, `QDRANT_*`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`,
  `CLERK_SECRET_KEY`, `RAZORPAY_*`, `AI_API_KEY` — all Phase 2+/billing/Clerk concerns, out of
  phase-00 scope.
- No Postgres container was running and no migration had been applied against a real database —
  regenerating the placeholder migration is safe (no data at risk).
- Package manager: pnpm (`pnpm-lock.yaml`, `pnpm-workspace.yaml`), matches the phase doc. No
  conversion needed.

## 1. Repository topology — binding decision, overrides the phase document

**Contradiction found.** `phase-00-foundation.md` §1 and `plan.md` §44 are explicit and binding:
*"this is not a multi-package `apps/*` monorepo split; it is one Next.js codebase"* — a single
`src/` tree, Next.js Route Handlers for all API routes, RSC calling the service layer directly
(no network hop).

The existing repo is the opposite: a real `apps/api` (Express) + `apps/web` (Next.js, frontend
only) + `apps/worker` (future Inngest) split, with three commits of working code already built
that way.

**Resolution.** Asked the user directly (this is a high-blast-radius call — collapsing the
monorepo would discard/rewrite `apps/api` and rip out Clerk). The user's explicit instruction:
*"i use monorepo and in /app/api have backend and /apps/web have frontend and /apps/worker have
inngest architecture"* — i.e., keep the monorepo split. This is a deliberate user override of
`plan.md`/phase-00's architecture decision, which takes precedence over the document. Recording
it here rather than silently picking a side, per instructions.

**Consequence for every "src/" path named in the phase document:** they are remapped onto the
existing package layout as follows. This mapping is binding for Prompts 2 and 3 too.

| Phase doc path | This repo |
|---|---|
| `src/app/api/**` (route handlers) | `apps/api/src/routes/**`, `apps/api/src/controllers/**` (Express) |
| `src/lib/*.ts` | `apps/api/src/lib/*.ts` |
| `src/db/prisma.ts`, `src/db/repositories/*` | `packages/db/src/client.ts` (Prisma client) + future `apps/api/src/modules/**/*.repository.ts` |
| `src/inngest/**` | `apps/worker/**` (created in Prompt 2, per phase-00 — worker has nothing to run until Phase 03 for real functions, but the no-op wiring lands in Prompt 2) |
| `src/components/ui/**` | `apps/web/src/components/ui/**` (already populated) |
| `tests/{unit,integration,fixtures}/` | `apps/api/tests/{integration,fixtures}/` + colocated `*.test.ts` in `apps/api/src/**` |

**RSC-calls-service-layer-directly (plan.md §29.2) does not apply** — `apps/web` is a pure
frontend and will consume `apps/api` over HTTP (it already ships `@tanstack/react-query`, which
fits this shape). This is out of scope for Phase 00/this prompt regardless (no routes are wired
to the frontend yet); noted here so Prompt 2/3 don't silently assume RSC-direct-call semantics
from `plan.md`.

**Edge-runtime tracing caveat does not apply.** Phase-00 §5 warns that Next.js middleware runs on
the Edge runtime where `AsyncLocalStorage` is unreliable, so the phase doc has the Node-runtime
request wrapper own `traceId` generation instead of relying on middleware. In this topology,
`apps/api` is a plain Node Express process — there is no Edge runtime anywhere in the request
path. `AsyncLocalStorage` is fully reliable at the Express middleware layer, so `tracing.ts`'s
context is established in ordinary Express middleware, seeded from an inbound
`x-request-id`/`x-trace-id` header when present. Recording this because the *reasoning* behind
the original caveat (ALS reliability) still matters even though the *mechanism* it warns about
(Edge middleware) isn't present here.

## 2. Rule B reconciliation (ESLint boundary: who may import `@prisma/client`)

Phase-00 §3 says "only `db/repositories/*` may import `@prisma/client`"; phase-01 §18 places
`project.repository.ts` at `src/modules/projects/project.repository.ts` — a conflict the prompt
explicitly calls out and asks to be resolved without weakening the rule.

Adapted for the apps/*+packages/db topology (see §1 above): the repository layer is defined as
**`packages/db/**` plus any file matching `apps/api/src/modules/**/*.repository.ts`**. Only those
files may import `@prisma/client` or deep-import `packages/db/src/generated/**`. Everything else
(routes, controllers, other packages, `apps/worker`) must go through the `prisma` singleton
re-exported from `@repo/db` (`packages/db/src/index.ts`) — they may never touch the Prisma client
type/import directly. This is stricter than the literal phase-00 wording (it forbids raw
`@prisma/client` imports even in future feature repositories, funneling everyone through one
singleton) rather than looser, per the instruction not to resolve the conflict by weakening the
rule.

## 3. Prisma schema — removed the existing `email` field, switched `cuid()` → `uuid()`

`packages/db/prisma/schema.prisma`'s `User` model had `email String @unique` and
`@default(cuid())`. Phase-00 §6 gives the placeholder schema verbatim — `User { id, createdAt,
updatedAt }` only, `@default(uuid())` — and calls anything beyond that "schema creep... treated
as a defect." Adapted (not deleted) the existing model in place: dropped `email`, switched the id
default to `uuid()`, and added the missing `Project` model. Phase 01 (Prompt 3) reintroduces
`email` with the full field-complete model per `plan.md` §24.2 — this migration is disposable
scaffolding, not a contract.

## 4. Migration reset

Only one migration existed (`20260823184926`, `User` with `email` only), no Postgres container
was running, and nothing had ever applied it against real data. A Prisma migration's SQL can't be
edited in place without corrupting migration history integrity, and the completion criterion
requires *exactly one* migration containing only the two placeholder tables. Deleted that
migration directory and regenerated a fresh initial migration against the corrected schema
(`User` + `Project`, PKs only) — not a `prisma migrate reset` against a live database, just
removing dead migration history that predates any real data. No `--force-reset` /
`--accept-data-loss` flags used.

## 5. `.env.example` — kept the Phase 2+/Clerk placeholders, sectioned them off

`.env.example` already lists `REDIS_URL`, `QDRANT_*`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`,
`CLERK_SECRET_KEY`, `RAZORPAY_*`, `AI_API_KEY` — none of them phase-00 concerns, and
`CLERK_SECRET_KEY` directly conflicts with phase-00's binding "Auth.js/NextAuth, not Clerk"
decision (§1 of the phase doc). Did not delete them — removing already-planned-for variables
looks like abandoning that work, and the phase-00/Clerk conflict is an auth decision that belongs
to Phase 01 (Prompt 3), not this one. Instead, restructured the file into a clearly labeled
"Phase 00 — required now" section (the exact §19 list, plus `PORT`/`FRONTEND_URL`, which
`apps/api`'s Express topology needs and which `plan.md`'s Next.js-only assumption never accounts
for) and a "Reserved for later phases — not wired up yet" section. **Flagging explicitly:** the
Clerk vs. Auth.js contradiction is unresolved and must be decided in Prompt 3, not silently
carried forward.

## 6. Root `prisma.config.ts` / root `prisma`+`@prisma/client` deps removed

Dead scaffolding: root `prisma.config.ts` pointed at `prisma/schema.prisma`, which doesn't exist
at the repo root (the real schema lives in `packages/db/prisma/schema.prisma`, with its own
`prisma.config.ts`). Nothing in any script referenced the root config. Removed the root
`prisma.config.ts` and the root-level `prisma`/`@prisma/client` package.json entries — keeping
`@prisma/client` importable from the workspace root would also make Rule B (§2 above) trivially
bypassable from any package via a root-hoisted import.

## 7. Request wrapper — Express middleware instead of a single `withApiRoute` function

Phase-00 §7 wants one `withApiRoute(handler, { component })` wrapper "consumed by every route."
Express doesn't wrap route registration the same way Next.js Route Handlers do, and Express
doesn't auto-catch thrown/rejected errors in handlers. Built the equivalent as two pieces in
`apps/api/src/lib/http.ts`: (1) `requestContext` — global middleware establishing the trace
context + timing + the single "request completed"/"request failed" log line (mounted once, in
`app.ts`), and (2) `withRoute(handler, { component })` — a per-handler wrapper (Express's
`asyncHandler` pattern) that forwards thrown `AppError`/unknown errors to `next()`, where the
shared error-handling middleware renders the standard envelope. Together these satisfy FR2/FR3
exactly as specified, in Express idiom rather than Next.js idiom.

## 8. `@/*` path alias — added to apps/web only, not apps/api

Task item 1 asks for a `@/*` → `src/*` alias. `apps/web` already had it (Next.js/webpack
bundler resolution — works natively). `apps/api` runs on plain Node with
`module`/`moduleResolution: NodeNext` — there is no bundler, so a TS-only `paths` alias
would type-check but **not resolve at runtime** under `tsx`/`node` without extra tooling
(`tsc-alias`, a custom loader, or Node's `imports` `#`-prefixed subpath imports — which
isn't the same alias shape). Adding that tooling to a foundation phase for a cosmetic
import-path preference is exactly the kind of accidental complexity worth avoiding here.
`apps/api` keeps the codebase's existing convention (explicit relative, `.js`-suffixed
imports, required by NodeNext ESM resolution) instead.

## 9. Prisma client staleness after the first `migrate dev`

Immediately after generating the fresh init migration, `packages/db/src/generated/`
only contained `User.ts`, not `Project.ts`, even though `migrate dev` normally
auto-runs `generate` against the current schema. Root-caused to likely interference
from `pnpm install`'s own Prisma postinstall hook running `generate` without
`DATABASE_URL` set in between my migration step and the typecheck pass. Fixed by
running `pnpm --filter @repo/db exec prisma generate` explicitly; documented as an
explicit step (`pnpm db:generate`) in the setup sequence in README.md rather than
relying on any implicit postinstall generation.

## 10. Root ESLint config scoped to exclude `apps/web`; `^_` unused-var convention added

Running the repo-wide boundary/no-console config (`eslint.config.mjs`) against the
whole tree also linted `apps/web`, which already has its own complete, Next.js-flavored
config (react-hooks, react-compiler) run via `turbo lint` — the generic root config
lacks those plugins, so it reported "rule definition not found" for a legitimate
`eslint-disable` comment that apps/web's own config resolves correctly. Added
`apps/web/**` to the root config's global `ignores`: the root config's job is the
architectural boundary/no-console rules for `apps/api`, `apps/worker`, and
`packages/*`, none of which have their own dedicated config; `apps/web` is fully
covered by its own. Also configured `@typescript-eslint/no-unused-vars` with
`argsIgnorePattern`/`varsIgnorePattern: "^_"` — needed because Express's
`errorHandler(err, req, res, next)` must keep an unused `next` param to preserve the
4-arg arity Express uses to detect error-handling middleware.

## 11. Two pre-existing `apps/web` lint failures fixed incidentally

`pnpm lint` failed on two files neither created nor touched by this phase's work:
`apps/web/src/hooks/use-mobile.ts` and `apps/web/src/components/ui/carousel.tsx`
(shadcn-generated), both tripping the `react-hooks/set-state-in-effect` rule that
ships with this repo's `eslint-config-next` version. Since `pnpm lint` is a required
verification command and these are small, mechanical, low-risk fixes unrelated to any
design decision:
- `use-mobile.ts`: switched to a lazy `useState` initializer for the initial value,
  leaving the effect to only subscribe to the media-query change event (the rule's
  own suggested pattern) — a strict improvement, not just a lint suppression.
- `carousel.tsx`: added a scoped `eslint-disable-next-line` with a one-line reason.
  This one genuinely cannot be restructured the "correct" way — `canScrollPrev`/
  `canScrollNext` mirror embla-carousel's imperative API object, which only exists
  after mount; there is no render-time value to compute them from initially.

Did not otherwise touch `apps/web`'s application code, Clerk wiring, or the oversized
shadcn component set (present-but-more-than-the-task-asked-for, per task item 1) —
trimming that is Prompt 2/3's call, not this one's.

## 12. Verification — commands run and actual results

All run against this repo, in order, after all of the above:

| Command | Result |
|---|---|
| `pnpm install` | Clean install, all workspaces resolved |
| `pnpm typecheck` (`turbo typecheck`) | Pass — `api`, `web` (strict, `noUncheckedIndexedAccess`, `noImplicitOverride`) |
| `pnpm lint` (`turbo lint` + root boundary/no-console config) | Pass, 0 errors |
| `pnpm test:unit` | Pass — 7 files, 50 tests |
| `pnpm test:integration` | Pass — 1 file, 3 tests (Testcontainers Postgres: migrate deploy, round-trip, no schema creep) |
| `pnpm build` (`turbo build`) | Pass — `api` (`tsc`), `web` (`next build`) |
| `prisma migrate status` against a fresh local DB | `Database schema is up to date!`, 1 migration found |
| Behavioral: `DATABASE_URL` absent at boot | Refuses to boot; structured log line names `DATABASE_URL` explicitly; exit code 1. Real `apps/api/.env` never touched (used `DOTENV_CONFIG_PATH` pointed at a throwaway file instead) |
| Behavioral: lint fixtures | All three (`rule-a/b/c-violation.ts`) fail with `no-restricted-imports`, each message naming its rule (A/B/C) and citing phase-00 §3 |
| Smoke test: existing `/api/health` through the new global middleware | 200, `x-trace-id` header present, route itself unchanged (out of scope this prompt) |
| Smoke test: unmatched route | 404, standard envelope `{"error":{"code":"NOT_FOUND",...}}` |

**Safety note, not a defect:** `packages/db/.env` (pre-existing, gitignored, untouched by
this work) points at a real external Neon Postgres instance. Every Prisma command run
during this work explicitly overrode `DATABASE_URL` to the local docker-compose Postgres
instead. The newly-added root-level `pnpm db:migrate` / `pnpm db:deploy` (unlike
`db:generate`, which needs no DB connection and was verified safe to run as-is) will
target whatever `packages/db/.env` resolves to if run without an override — currently
Neon, not local Postgres. Flagged here rather than silently changed, since overwriting
that file would discard the user's own configuration.

---

# Phase 00 completion (Prompt 2)

Prompt 1 left tasks 9–13 of §17 unbuilt. This section records the decisions made
finishing them. Auth/data-model decisions from the same pass live in
`phase-01-log.md`.

## 13. `/api/health` — DB check through the repository layer, new `DbUnavailableError`

Phase-00 §7 requires the route to check DB connectivity, but Rule B forbids route
handlers touching Prisma. Added `apps/api/src/modules/health/health.repository.ts`
(`pingDatabase()` → `SELECT 1`) — the `*.repository.ts` suffix is what Rule B keys on,
so this needed no lint exception. The controller catches any throw from it and raises a
new `DbUnavailableError`.

`DbUnavailableError` is a distinct subclass rather than reusing `ServiceUnavailableError`
because §7/§12 specify the code `DB_UNAVAILABLE`, and `AppError` derives the envelope's
`code` from the class. Both are 503; the new one names the actual dependency, which is
what an uptime check needs to distinguish.

The route now goes through `withRoute(..., { component: "api.health" })`, so it emits
exactly one log line tagged `api.health` (previously the pre-existing placeholder
controller bypassed the wrapper and fell back to `component: "http"`). Response body is
`{status, traceId}` only — no versions, no stack traces (§13).

## 14. Frontend shell — route groups required moving `page.tsx`

`(marketing)` and `(app)` route groups added per plan.md §44. `src/app/page.tsx` had to
move to `src/app/(marketing)/page.tsx`: with a root-level `page.tsx` *and* a
`(marketing)` group, `/` would resolve from two places, which Next.js rejects. Moved
with `git mv` so history is preserved.

Both groups get their own `layout.tsx` wrapping the shared nav placeholder. `(app)`
deliberately contains **no auth check** — protected-route enforcement is Prompt 3's
work (phase-01 §17 step 10). The group exists now so those pages land somewhere that
already has the right conventions.

`error.tsx` uses the **`retry`** prop, not `reset`. Verified against the installed
Next.js 16.3.2's own bundled docs
(`node_modules/next/dist/docs/…/file-conventions/error.md`), whose version table records
`retry` as stable since 16.3.0. `reset` is the older API.

`global-error.tsx` replaces the root layout when active, so it gets none of the app's
fonts, global CSS, or theme class — it therefore uses inline styles and a neutral
palette that reads acceptably in both light and dark. This is the framework's documented
constraint, not a style preference.

Theme handling uses `next-themes` (newly added) with `attribute="class"`, matching the
`@custom-variant dark (&:is(.dark *))` already in `globals.css`. `suppressHydrationWarning`
on `<html>` is required by `next-themes` — it writes the class before React hydrates.

## 15. Inngest Dev Server — `pnpm dlx`, not a pinned devDependency

`inngest-cli`'s postinstall **overwrites its JS entrypoint with a native ELF binary**.
pnpm generates its bin shim at install time assuming a node script, so the shim then
tries `node <elf>` and dies with `SyntaxError: Invalid or unexpected token`. This is
inherent to how the package ships, not environment-specific, so pinning it as a
devDependency would leave a permanently broken `pnpm exec inngest-cli`.

`pnpm dev:inngest` therefore runs `pnpm dlx inngest-cli@latest dev …`, which matches
Inngest's own documented `npx inngest-cli@latest dev` guidance and works. (Plain `npx`
fails in this repo: the root `devEngines.packageManager` is pnpm, and npm refuses with
`EBADDEVENGINES`.) The Dev Server is a local-dev tool that never runs in CI, so the
unpinned version carries no CI-flakiness risk.

`INNGEST_DEV=1` is required in the worker's environment for local runs — without it the
SDK runs in cloud mode and rejects unsigned Dev Server requests. Documented in README.

## 16. CI — `db:generate` before anything that compiles

`.github/workflows/ci.yml` runs install → **generate** → lint → typecheck → unit →
integration → build on every PR. The generate step is load-bearing and easy to miss:
the Prisma client is emitted into `packages/db/src/generated/` and is gitignored, so
without it `@repo/db` doesn't resolve and typecheck/build/tests all fail on a clean
checkout. It needs no database connection.

Dummy values for every required variable are set in the job-level `env:` block so the
fail-fast config module boots. Nothing is ever `echo`ed (§13). The integration job
overrides `DATABASE_URL` with the Testcontainers instance it starts itself, so the dummy
value is never dialled.

The boundary-fixture assertion needs no separate CI step — it is
`apps/api/src/lib/boundaries.test.ts`, already inside `pnpm test:unit`, and it lints all
three fixtures with `ignore: false`.

**GitHub Actions secrets cannot start with `GITHUB_`** (reserved prefix). It doesn't
bite today — CI uses dummy OAuth values and never contacts GitHub — but it would the
moment someone tries to store `GITHUB_OAUTH_CLIENT_ID` as a real repository secret.
Recorded in `docs/deployment.md`.

## 17. Staging configuration — what could honestly be committed

No hosting provider is configured in this repo and no platform credentials are
available, so there is no meaningful `vercel.json`/`fly.toml` to write — inventing one
for an unchosen provider would be fiction. What was committed instead is provider-
independent and actually useful: `docs/deployment.md` with the per-deployable build/start
commands, the full environment-variable matrix, the release-path `migrate deploy` step,
the health-check URL, and a prominent OAuth callback-URL section (phase-01 §22's named
top failure).

**The deploy itself was not performed and is not claimed.** "Skeleton deployed to
staging and `/api/health` reachable there" remains outstanding — listed in
`docs/deployment.md` and in the final report.
