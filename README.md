# gitprreviewer — GitHub AI PR Reviewer

pnpm + Turborepo monorepo:

```text
apps/
  api/      Express backend — routes, controllers, src/lib/ (logger, tracing, errors,
            config, validation, http, auth) — most backend code lives here
  web/      Next.js (App Router) frontend
  worker/   Inngest client, middleware, and functions, served at /api/inngest
packages/
  db/       Prisma schema, migrations, the generated client, and the Auth.js adapter
            (@repo/db) — the only package allowed to import @prisma/client directly
```

See `docs/decisions/phase-00-log.md` for why this repo uses an `apps/*` split instead
of the single-`src/`-tree layout the architecture docs describe, and how the phase
documents' rules/paths map onto it.

## Local setup

```bash
pnpm install

docker compose up -d              # local Postgres on localhost:5432 (db: dev)

cp .env.example apps/api/.env     # dev-only values are fine locally; see the
                                   # AUTH_URL note below before real GitHub sign-in

pnpm db:generate                  # generate the Prisma client (no DB connection needed)
pnpm db:migrate                   # apply migrations (prisma migrate dev)

pnpm dev                          # api :4000 · web :3000 · worker :4500
```

`apps/worker` needs its own `.env` (`INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`,
`WORKER_PORT`) — same dev values as `apps/api`.

### Inngest Dev Server

In a second terminal, alongside `pnpm dev`:

```bash
pnpm dev:inngest                  # Dev Server UI on http://localhost:8288
```

Run the worker with `INNGEST_DEV=1` set (put it in `apps/worker/.env`) so the SDK talks
to the local Dev Server instead of Inngest Cloud — without it, requests are rejected as
unsigned. Then open http://localhost:8288, confirm the app registers with exactly one
function (`noop-handler`), and send `internal/noop.ping` to see a `traceId`-carrying log
line from the worker.

### GitHub OAuth (sign-in)

`.env`'s placeholder OAuth values are enough to boot and to run every test. For a real
sign-in, create a GitHub OAuth App whose callback URL is **exactly**
`$AUTH_URL/api/auth/callback/github` (locally: `http://localhost:4000/api/auth/callback/github`)
and set `GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET`. Callback-URL mismatch is
the most common failure here — see `docs/deployment.md`.

`packages/db` reads its own `packages/db/.env` for `DATABASE_URL` when you run Prisma
CLI commands directly from that package — keep it pointed at your local Postgres
unless you deliberately mean to target another database.

## Scripts

| Command | Does |
|---|---|
| `pnpm dev` | Runs every app's dev server (turbo) |
| `pnpm dev:inngest` | Inngest Dev Server, pointed at the worker's `/api/inngest` |
| `pnpm build` | Builds every app |
| `pnpm start` | Starts every app's production build |
| `pnpm lint` | Per-package lint (turbo) + the repo-wide architectural boundary/no-console rules (`eslint.config.mjs`) |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test` | `test:unit` then `test:integration` |
| `pnpm test:unit` | Fast, no-I/O unit tests (colocated `*.test.ts`) |
| `pnpm test:integration` | Testcontainers-backed tests against a real, ephemeral Postgres (`apps/api/tests/integration/`) |
| `pnpm db:generate` / `db:migrate` / `db:deploy` / `db:studio` | Prisma workflow, delegated to `packages/db` |

## Architecture boundaries (enforced by lint, not just docs)

- `apps/api/src/routes/**` and `apps/api/src/controllers/**` may not import the future
  `ai`/`github`/`embedings` packages directly.
- Only `packages/db/**` (or a `*.repository.ts` file) may import `@prisma/client` —
  everything else imports the `prisma` singleton from `@repo/db`.
- `apps/worker/src/inngest/functions/**` may not import `apps/api`'s routes/controllers.

`apps/api/tests/fixtures/lint/` contains one deliberate violation per rule, proven to
fail lint by `apps/api/src/lib/boundaries.test.ts`.

## Observability

Every request through `apps/api` gets a ULID `traceId` (seeded from an inbound
`x-trace-id`/`x-request-id` header when present), propagated via `AsyncLocalStorage`,
and produces exactly one structured JSON log line — see `apps/api/src/lib/{tracing,logger,http}.ts`.
Once a request authenticates, `requireSession()` adds `userId` to that same context, so
every later log line in the request carries it too.

Inngest function runs get the same envelope from
`apps/worker/src/inngest/middleware/logging.ts`.

## Authentication

GitHub OAuth via Auth.js (`@auth/express`) with **database-backed sessions** through the
Prisma adapter — deliberately not JWT, so sessions can be revoked (plan.md §35.1,
phase-01 §1/§22). Requested scopes are `read:user` and `user:email` only; the OAuth
identity answers *who is signed in* and is never used for repository access (that is the
GitHub App installation identity, arriving in Phase 02).

`requireSession(req)` (`apps/api/src/lib/auth/session.ts`) is the single entry point for
resolving the caller. A missing, invalid, or expired session throws
`UnauthenticatedError` (401) — it never falls back to a default user.

> `User.githubUserId` is a `BigInt` and has no native JSON representation. It is
> converted to a string at the API/DTO boundary, so `session.user.githubUserId` is always
> a string. Keep any new DTO carrying a `BigInt` to that same rule.
