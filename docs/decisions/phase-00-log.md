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
