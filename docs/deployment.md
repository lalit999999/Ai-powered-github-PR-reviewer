# Deployment

Covers the staging/production configuration for the three deployables in this
repository. Phase 00 §3/§15 requires the configuration to be committed; the actual
deploy is a manual step (see [Outstanding](#outstanding-manual-steps)).

## Deployables

| Deployable    | Build                        | Start                        | Serves                                                                                        |
| ------------- | ---------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/web`    | `pnpm --filter web build`    | `pnpm --filter web start`    | Next.js UI                                                                                    |
| `apps/api`    | `pnpm --filter api build`    | `pnpm --filter api start`    | Express API, `/api/health`, `/api/auth/*`, `/api/projects*`, `/auth/*` (sign-in/error bridge) |
| `apps/worker` | `pnpm --filter worker build` | `pnpm --filter worker start` | Inngest functions at `/api/inngest`                                                           |

`apps/worker` has its own Postgres and GitHub App access as of Phase 03 (`Dockerfile.worker`
at the repo root — see [Worker container](#worker-container) below), but still registers only
one diagnostic Inngest function (`noop-handler`); `repository-index`, the first real one,
is Prompt 2 of Phase 03.

## Release path

Migrations are applied as a release step, never at application boot — a booting app
racing itself across replicas is how migration deadlocks happen.

```bash
pnpm install --frozen-lockfile
pnpm db:generate          # Prisma client (no DB connection needed)
pnpm db:deploy            # prisma migrate deploy — the release-time migration step
pnpm build
```

`pnpm db:deploy` resolves `DATABASE_URL` from the environment. It applies only
already-committed migrations and never generates new ones (that is `migrate dev`,
which is local-only).

## Environment variable matrix

Names only — never commit values. `.env.example` is the authoritative list.

| Variable                     | api | worker | web | Notes                                                                                 |
| ---------------------------- | :-: | :----: | :-: | ------------------------------------------------------------------------------------- |
| `NODE_ENV`                   | ✅  |   ✅   | ✅  | `production` in staging and production                                                |
| `LOG_LEVEL`                  |  ○  |   ○    |  —  | defaults to `info`                                                                    |
| `DATABASE_URL`               | ✅  |   ✅   |  —  | also needed by the release-step `migrate deploy`; same database, two deployables      |
| `INNGEST_EVENT_KEY`          | ✅  |   ✅   |  —  | per-environment key                                                                   |
| `INNGEST_SIGNING_KEY`        | ✅  |   ✅   |  —  | per-environment key                                                                   |
| `PORT`                       | ✅  |   —    |  —  | api's listen port (defaults to 4000)                                                  |
| `WORKER_PORT`                |  —  |   ✅   |  —  | worker's listen port (defaults to 4500)                                               |
| `FRONTEND_URL`               | ✅  |   —    |  —  | CORS origin — the deployed `apps/web` origin                                          |
| `GITHUB_OAUTH_CLIENT_ID`     | ✅  |   —    |  —  | **per-environment** — see below                                                       |
| `GITHUB_OAUTH_CLIENT_SECRET` | ✅  |   —    |  —  | **per-environment** — see below                                                       |
| `AUTH_SECRET`                | ✅  |   —    |  —  | `openssl rand -hex 32`; distinct per environment                                      |
| `AUTH_URL`                   | ✅  |   —    |  —  | **per-environment** — see below                                                       |
| `NEXT_PUBLIC_API_URL`        |  —  |   —    | ✅  | the deployed `apps/api` origin                                                        |
| `GITHUB_APP_ID`              | ✅  |   ✅   |  —  | Phase 02/03 — the GitHub **App**, not the OAuth App; same App, two deployables        |
| `GITHUB_APP_PRIVATE_KEY`     | ✅  |   ✅   |  —  | base64 of the `.pem` — see below                                                      |
| `GITHUB_APP_SLUG`            | ✅  |   —    |  —  | builds the install link; worker never needs it                                        |
| `GITHUB_APP_WEBHOOK_SECRET`  | ✅  |   —    |  —  | set on GitHub now; unread until Phase 06; worker never receives webhooks              |
| `REDIS_URL`                  | ✅  |   ✅   |  —  | Phase 02/03 — installation-token cache, shared by both deployables                    |
| `WORKER_TEMP_DIR`            |  —  |   ○    |  —  | Phase 03 — tarball extraction scratch dir; defaults to a container-standard temp path |
| `INDEX_MAX_TOTAL_BYTES`      |  —  |   ○    |  —  | Phase 03 — zip-bomb defense; defaults to 2 GiB                                        |
| `INDEX_MAX_FILE_COUNT`       |  —  |   ○    |  —  | Phase 03 — defaults to 200,000                                                        |

✅ required · ○ optional · — not used

Every variable in the ✅ column is validated at boot. A missing one exits the process
with a message naming it, rather than starting and failing on first use (phase-00 FR4).

> `LOG_LEVEL` is read directly from `process.env` by the logger so it applies to the
> config module's own failure log line — the one that reports a bad config. It is the
> single deliberate exception to "config comes from the validated module."

## ⚠️ OAuth callback URL — the #1 failure in this phase

`plan.md` §45 and phase-01 §22 both name callback-URL mismatch as the most common
Phase 1 failure. **Verify this first in any new environment, before debugging anything
else.**

The callback URL is derived from `AUTH_URL` plus the mount path, and must match what
is registered on the GitHub OAuth App **exactly** — scheme, host, port, and path, with
no trailing slash:

```
$AUTH_URL/api/auth/callback/github
```

| Environment | `AUTH_URL`                        | Registered callback URL                                    |
| ----------- | --------------------------------- | ---------------------------------------------------------- |
| Local       | `http://localhost:4000`           | `http://localhost:4000/api/auth/callback/github`           |
| Staging     | `https://api-staging.example.com` | `https://api-staging.example.com/api/auth/callback/github` |
| Production  | `https://api.example.com`         | `https://api.example.com/api/auth/callback/github`         |

Notes that make this go wrong in practice:

- **A GitHub OAuth App accepts only one callback URL.** Use a **separate OAuth App per
  environment** — do not try to share one across local/staging/production.
- `AUTH_URL` points at **`apps/api`**, not `apps/web`. Auth.js runs inside the Express
  API in this topology, so the callback lands on the API origin. Pointing it at the web
  origin is the single easiest way to get this wrong.
- Behind a TLS-terminating proxy, `apps/api` sets `trust proxy` so `X-Forwarded-Proto`
  is honored. Without that, Auth.js sees plain HTTP and drops the `secure` cookie flag.
- **GitHub Actions secrets cannot be named with a `GITHUB_` prefix** — that prefix is
  reserved. If real OAuth credentials are ever needed in CI, store them under different
  secret names and map them in the workflow's `env:` block. CI today uses dummy values
  and never contacts GitHub.

## ⚠️ `apps/web` and `apps/api` must be same-site

The session cookie is `sameSite=lax` (phase-01 §4/§13, and Auth.js's default). A `lax`
cookie is sent on a cross-**origin** request but **not** on a cross-**site** one — and
"site" means the registrable domain, ignoring scheme, port, and subdomain.

| Frontend                  | API                       | Same site?              | Cookie auth works?                                     |
| ------------------------- | ------------------------- | ----------------------- | ------------------------------------------------------ |
| `http://localhost:3000`   | `http://localhost:4000`   | yes (ports don't count) | ✅                                                     |
| `https://app.example.com` | `https://api.example.com` | yes (`example.com`)     | ✅                                                     |
| `https://app.example.com` | `https://api.example.io`  | **no**                  | ❌ sign-in appears to work, then every API call is 401 |
| `https://app.vercel.app`  | `https://api.fly.dev`     | **no**                  | ❌ same                                                |

This is easy to get wrong when the two deployables land on different platforms' default
domains. **Put both behind subdomains of one registrable domain**, or the frontend will
sign in successfully and then be unable to call the API at all. `FRONTEND_URL` (CORS
origin, api) and `NEXT_PUBLIC_API_URL` (api origin, web) must point at that pair.

## Infrastructure

| Dependency | Used by                   | Since                           | Notes                                                |
| ---------- | ------------------------- | ------------------------------- | ---------------------------------------------------- |
| PostgreSQL | `apps/api`, `apps/worker` | Phase 00 (worker: **Phase 03**) | The system of record. One database, two deployables. |
| Redis      | `apps/api`, `apps/worker` | Phase 02 (worker: **Phase 03**) | Installation-access-token cache only.                |

**Redis holds no durable state.** It caches GitHub installation tokens (50-minute TTL)
and ETag entries. Losing it costs one extra token mint per installation and some
rate-limit budget — never data. If Redis is unreachable, `apps/api` logs a warning
(rate-limited to once a minute so an outage cannot flood the logs) and falls back to a
process-local in-memory cache rather than failing requests. Provision it, monitor it,
but do not treat it as a database. See `docs/decisions/phase-02-log.md` §8.

Locally, `docker compose up -d` starts both Postgres and Redis.

## ⚠️ GitHub App vs. GitHub OAuth App

From Phase 02 there are **two** GitHub registrations per environment, and they are not
interchangeable:

|               | GitHub **OAuth App** (Phase 01)                         | GitHub **App** (Phase 02)                                      |
| ------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| Answers       | _Who is signed in?_                                     | _What repository data may we read?_                            |
| Credentials   | `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_SLUG` |
| Registered at | Developer settings → OAuth Apps                         | Developer settings → GitHub Apps                               |
| Used for      | Sign-in, session                                        | Every repository read and every review comment                 |

`plan.md` §45 names conflating the two as a top failure point for Phase 02. Registration
is documented step by step in [`github-app-setup.md`](./github-app-setup.md); the
requested permissions and the reasoning behind each are in
[`github-app-permissions.md`](./github-app-permissions.md).

**Also per-environment.** A GitHub App has one webhook URL and one callback URL, so
sharing one across environments fails the same way sharing an OAuth App does. Register
one App per environment.

**`GITHUB_APP_PRIVATE_KEY` encoding.** Store it as `base64 -w0 your-app.private-key.pem`
— one line, no escaping, survives every secret store. `apps/api` decodes and shape-checks
it at boot and refuses to start on a mangled key, so this fails in the first second
rather than at a user's first repository connect.

**`GITHUB_APP_WEBHOOK_SECRET` is required but unread until Phase 06.** Generate it and
set it on the App now so the webhook configuration is complete. Until Phase 06 builds
`/api/webhooks/github`, GitHub's delivery attempts will 404 — expected, not a bug
(phase-02 §1).

## Health check

Point the uptime check at:

```
GET $API_ORIGIN/api/health   →   200 {"status":"ok","traceId":"…"}
```

Returns `503` with `{"error":{"code":"DB_UNAVAILABLE",…}}` when Postgres is
unreachable — the check should treat any non-200 as down. The response exposes nothing
beyond `status` and `traceId` (no versions, no stack traces) by design (phase-00 §13).

`apps/worker` has its own, separate check — see below.

## Worker container

`Dockerfile.worker` (repository root) is the indexer worker's real deployable, built and
verified as part of Phase 03 (docs/decisions/phase-03-log.md). It is a multi-stage build
using `turbo prune worker --docker` (verified against the installed turbo@2.10.11) to
include only the workspace subset apps/worker actually needs — `@repo/db`, `@repo/github`,
`@repo/observability`, `@repo/shared`, and `worker` itself — and nothing from apps/api or
apps/web.

### Deploy target: a long-running container platform — never Vercel

phase-03 §1 and `plan.md` §1.3 change ③ are explicit, and it is worth restating why
rather than just complying: tarball extraction and (Phase 04/05) parsing and embedding
are minutes of CPU and hundreds of MB of disk. Vercel's function execution limits and
read-only-except-`/tmp` filesystem make that fragile in a way that has nothing to do
with code quality — it is a mismatch between the workload's shape and the platform's.
The right target is a long-running container platform with a real, sizeable, writable
scratch volume: **Fly.io, Railway, or ECS/Fargate** are all suitable; none has been
provisioned from this environment (no hosting credentials are available here — see
Outstanding below). Whichever is chosen, provision it with:

- A persistent (or at least generously-sized ephemeral) disk or `tmpfs` for
  `WORKER_TEMP_DIR` sized well past `INDEX_MAX_TOTAL_BYTES` (default 2 GiB) — the
  container's own scratch mount, not the app's root filesystem, which is read-only (see
  below).
- Enough memory to hold the archive-extractor's per-job working set. This phase streams
  extraction (never buffers the whole archive), so the requirement is modest relative to
  repository size, but should still be sized deliberately once real repositories are
  indexed, not left at a platform default.
- The same `DATABASE_URL` apps/api uses (one Postgres instance, two deployables) and the
  same `REDIS_URL` (one Redis instance, two deployables, per phase-02 — installation
  tokens are shared, not re-minted separately by each).
- No public ingress requirement beyond what the platform needs for its own health
  checks — nothing external calls the worker directly; it is driven entirely by Inngest
  invoking `/api/inngest`.

### Container hardening

Verified locally, not just asserted (see docs/decisions/phase-03-log.md for the exact
commands run): the image runs as a non-root user (`worker`, uid/gid 1001), the root
filesystem is mounted read-only, and `WORKER_TEMP_DIR` (`/tmp/worker`) is a writable
`tmpfs` mount layered on top — both `docker run --read-only --tmpfs /tmp/worker:...` and
the `docker-compose.yml` `worker` service (below) configure this. `cap_drop: [ALL]` and
`no-new-privileges` are set in compose; the equivalent should be configured on whichever
platform is chosen for real deployment (most container platforms expose this as a
"drop all capabilities" or "no privilege escalation" setting).

### Health check

```
GET $WORKER_ORIGIN/api/inngest   →   200 {"function_count": N, "has_event_key": true, ...}
```

This is the Inngest SDK's own introspection endpoint — no custom health route was
written, because this one already proves the two things that matter: the Express process
is up, and the Inngest handler itself is correctly registered (not just listening on the
port). The Dockerfile's own `HEALTHCHECK` instruction uses the same endpoint.

### Running it locally

```bash
docker compose --profile worker up -d --build worker
```

Opt-in via the `worker` compose profile — a plain `docker compose up` (what `pnpm dev`
depends on for Postgres/Redis) does not build or start it, so this does not become a
tax on every contributor's local setup. Needs `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`,
`GITHUB_APP_ID`, and `GITHUB_APP_PRIVATE_KEY` in the shell environment (or a `.env` file
`docker compose` reads); see `.env.example`.

## Outstanding manual steps

These require credentials/hosting access and **have not been performed**:

- [ ] Provision the staging environment and deploy the skeleton to it.
- [ ] Confirm `/api/health` is reachable in staging and returns 200.
- [ ] Create the staging GitHub OAuth App and register its callback URL per the table above.
- [ ] Set every ✅ variable in the staging environment's secret store.
- [ ] Run one real GitHub sign-in against staging (phase-01 §14).

Phase 02 adds:

- [ ] Register the staging GitHub **App** per [`github-app-setup.md`](./github-app-setup.md).
- [ ] Generate and set `GITHUB_APP_WEBHOOK_SECRET` on the App and in the secret store.
- [ ] Provision Redis for staging and set `REDIS_URL`.
- [ ] Install the App on a real test account/org and connect one repository end to end
      (needs the routes and UI from Prompts 2 and 3 of this phase).

Phase 03 adds:

- [ ] Choose and provision a real long-running container host for `apps/worker`
      (Fly.io / Railway / ECS — see "Worker container" above) and deploy
      `Dockerfile.worker` to it. Verified locally against `docker build`/`docker run`/
      `docker compose` only (docs/decisions/phase-03-log.md); never deployed to any real
      hosting platform, because none is available from this environment.
- [ ] Confirm `/api/inngest` is reachable on the worker's real deployed origin and
      returns 200 with the expected `function_count`.
- [ ] Register the worker's app with Inngest Cloud (production mode, not `INNGEST_DEV`)
      once it has a real origin, per Inngest's own app-registration flow.
- [ ] A real ~1,000-file repository indexing end-to-end, on the real deployed worker —
      unreachable until Prompt 2 (the `repository-index` function) exists and a real
      GitHub App/installation exists (§14 of Phase 02, still outstanding).
