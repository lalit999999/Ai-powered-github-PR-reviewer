# gitprreviewer — GitHub AI PR Reviewer

pnpm + Turborepo monorepo:

```text
apps/
  api/      Express backend — routes, controllers, src/lib/ (logger, tracing, errors,
            config, validation, http, auth), src/github/ (GitHub App client: token
            minting, Octokit factory, ETag cache) — most backend code lives here
  web/      Next.js (App Router) frontend
  worker/   Inngest client, middleware, and functions, served at /api/inngest
packages/
  db/       Prisma schema, migrations, the generated client, and the Auth.js adapter
            (@repo/db) — the only package allowed to import @prisma/client directly
  shared/   (@repo/shared) type-only contracts shared between deployables — currently
            the Inngest event registry, so the API (sender) and worker (consumer)
            cannot drift apart. No runtime dependencies.
```

See `docs/decisions/phase-00-log.md` for why this repo uses an `apps/*` split instead
of the single-`src/`-tree layout the architecture docs describe, and how the phase
documents' rules/paths map onto it.

## Local setup

```bash
pnpm install

docker compose up -d              # Postgres on :5432 (db: dev) + Redis on :6379

cp .env.example apps/api/.env     # then FILL IN the empty values — every variable in
                                   # it is required, and apps/api refuses to boot while
                                   # any one of them is blank (that is the point)

pnpm db:generate                  # generate the Prisma client (no DB connection needed)
pnpm db:migrate                   # apply migrations (prisma migrate dev)

pnpm dev                          # api :4000 · web :3000 · worker :4500
```

Throwaway values that are enough to boot and to run the whole test suite — nothing here
contacts GitHub:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev
NODE_ENV=development
INNGEST_EVENT_KEY=dev
INNGEST_SIGNING_KEY=dev
PORT=4000
FRONTEND_URL=http://localhost:3000
GITHUB_OAUTH_CLIENT_ID=dev
GITHUB_OAUTH_CLIENT_SECRET=dev
AUTH_SECRET=$(openssl rand -hex 32)
AUTH_URL=http://localhost:4000
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY=$(base64 -w0 <<< '-----BEGIN RSA PRIVATE KEY-----
placeholder
-----END RSA PRIVATE KEY-----')
GITHUB_APP_SLUG=dev-app-slug
GITHUB_APP_WEBHOOK_SECRET=dev
REDIS_URL=redis://localhost:6379
```

Real GitHub sign-in needs a real OAuth App (see the `AUTH_URL` note below); connecting a
real repository needs a real GitHub App (see
[`docs/github-app-setup.md`](docs/github-app-setup.md)).

`apps/worker` needs its own `.env` (`INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`,
`WORKER_PORT`) — same dev values as `apps/api`. `apps/web` needs
`apps/web/.env.local` with `NEXT_PUBLIC_API_URL=http://localhost:4000`.

Signed-out visits to `/dashboard` or `/projects` redirect to `/signin`; the API answers
`401` rather than redirecting.

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

### GitHub App (repository access)

Separately from the OAuth App above, Phase 02 needs a GitHub **App** — the credential
that reads repository contents and publishes review comments. The two are never
interchangeable; `plan.md` §45 names conflating them as a top failure point.

`.env.example`'s placeholder App values are enough to boot and to run every test (no
test contacts GitHub). To connect a real repository, follow
[`docs/github-app-setup.md`](docs/github-app-setup.md) — it covers the permissions to
select, the events to subscribe to, and how to encode the private key
(`base64 -w0 your-app.private-key.pem`). What the App asks for and why, in
customer-legible terms, is in
[`docs/github-app-permissions.md`](docs/github-app-permissions.md).

Two things that look broken but are not:

- The App's webhook deliveries will 404 until **Phase 06** builds the receiving
  endpoint. `GITHUB_APP_WEBHOOK_SECRET` is required and set now, but no code reads it
  before Phase 06.
- If Redis is down, `apps/api` logs a warning and keeps working off an in-memory token
  cache. It is a cache, not a database.

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
  `ai`/`github`/`embedings` packages directly — nor, since Phase 02, the in-app GitHub
  client tree at `apps/api/src/github/**` by relative path.
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
identity answers *who is signed in* and is never used for repository access — that is the
GitHub App installation identity from Phase 02 (`docs/github-app-setup.md`).

`requireSession(req)` (`apps/api/src/lib/auth/session.ts`) is the single entry point for
resolving the caller. A missing, invalid, or expired session throws
`UnauthenticatedError` (401) — it never falls back to a default user.

`requireTenantAccess(session, { projectId })` (`apps/api/src/lib/auth/tenant-access.ts`)
is the single entry point for resolving *ownership* — no handler queries it directly, in
this phase or any later one. Missing, soft-deleted, and foreign resources all return
`404`; the difference survives only in a `warn` log line. Later phases extend this
helper rather than writing their own.

**`docs/auth.md` is the reference for both** — sign-in flow, session model, and the
`requireTenantAccess` usage/extension pattern.

> `User.githubUserId` is a `BigInt` and has no native JSON representation. It is
> converted to a string at the API/DTO boundary, so `session.user.githubUserId` is always
> a string. Keep any new DTO carrying a `BigInt` to that same rule.
