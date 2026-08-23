# gitprreviewer — GitHub AI PR Reviewer

pnpm + Turborepo monorepo:

```text
apps/
  api/      Express backend — routes, controllers, src/lib/ (logger, tracing, errors,
            config, validation, http) — everything in this phase lives here
  web/      Next.js (App Router) frontend
  worker/   Inngest functions (added in a later phase — nothing here yet)
packages/
  db/       Prisma schema, migrations, and the generated client (@repo/db) — the only
            package allowed to import @prisma/client directly
```

See `docs/decisions/phase-00-log.md` for why this repo uses an `apps/*` split instead
of the single-`src/`-tree layout the architecture docs describe, and how the phase
documents' rules/paths map onto it.

## Local setup

```bash
pnpm install

docker compose up -d              # local Postgres on localhost:5432 (db: dev)

cp .env.example apps/api/.env     # fill in DATABASE_URL, INNGEST_EVENT_KEY/SIGNING_KEY,
                                   # PORT, FRONTEND_URL — dev-only values are fine locally

pnpm db:generate                  # generate the Prisma client
pnpm db:migrate                   # apply migrations (prisma migrate dev)

pnpm dev                          # apps/api on :4000, apps/web on :3000
```

`packages/db` reads its own `packages/db/.env` for `DATABASE_URL` when you run Prisma
CLI commands directly from that package — keep it pointed at your local Postgres
unless you deliberately mean to target another database.

## Scripts

| Command | Does |
|---|---|
| `pnpm dev` | Runs every app's dev server (turbo) |
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
- `apps/worker/src/functions/**` may not import `apps/api`'s routes/controllers.

`apps/api/tests/fixtures/lint/` contains one deliberate violation per rule, proven to
fail lint by `apps/api/src/lib/boundaries.test.ts`.

## Observability

Every request through `apps/api` gets a ULID `traceId` (seeded from an inbound
`x-trace-id`/`x-request-id` header when present), propagated via `AsyncLocalStorage`,
and produces exactly one structured JSON log line — see `apps/api/src/lib/{tracing,logger,http}.ts`.
