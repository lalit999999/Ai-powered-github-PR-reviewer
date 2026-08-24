# Deployment

Covers the staging/production configuration for the three deployables in this
repository. Phase 00 §3/§15 requires the configuration to be committed; the actual
deploy is a manual step (see [Outstanding](#outstanding-manual-steps)).

## Deployables

| Deployable | Build | Start | Serves |
|---|---|---|---|
| `apps/web` | `pnpm --filter web build` | `pnpm --filter web start` | Next.js UI |
| `apps/api` | `pnpm --filter api build` | `pnpm --filter api start` | Express API, `/api/health`, `/api/auth/*`, `/api/projects*`, `/auth/*` (sign-in/error bridge) |
| `apps/worker` | `pnpm --filter worker build` | `pnpm --filter worker start` | Inngest functions at `/api/inngest` |

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

| Variable | api | worker | web | Notes |
|---|:--:|:--:|:--:|---|
| `NODE_ENV` | ✅ | ✅ | ✅ | `production` in staging and production |
| `LOG_LEVEL` | ○ | ○ | — | defaults to `info` |
| `DATABASE_URL` | ✅ | ✅ | — | also needed by the release-step `migrate deploy`; same database, two deployables |
| `INNGEST_EVENT_KEY` | ✅ | ✅ | — | per-environment key |
| `INNGEST_SIGNING_KEY` | ✅ | ✅ | — | per-environment key |
| `PORT` | ✅ | — | — | api's listen port (defaults to 4000) |
| `WORKER_PORT` | — | ✅ | — | worker's listen port (defaults to 4500) |
| `FRONTEND_URL` | ✅ | — | — | CORS origin — the deployed `apps/web` origin |
| `GITHUB_OAUTH_CLIENT_ID` | ✅ | — | — | **per-environment** — see below |
| `GITHUB_OAUTH_CLIENT_SECRET` | ✅ | — | — | **per-environment** — see below |
| `AUTH_SECRET` | ✅ | — | — | `openssl rand -hex 32`; distinct per environment |
| `AUTH_URL` | ✅ | — | — | **per-environment** — see below |
| `NEXT_PUBLIC_API_URL` | — | — | ✅ | the deployed `apps/api` origin |
| `GITHUB_APP_ID` | ✅ | ✅ | — | Phase 02/03 — the GitHub **App**, not the OAuth App; same App, two deployables |
| `GITHUB_APP_PRIVATE_KEY` | ✅ | ✅ | — | base64 of the `.pem` — see below |
| `GITHUB_APP_SLUG` | ✅ | — | — | builds the install link; worker never needs it |
| `GITHUB_APP_WEBHOOK_SECRET` | ✅ | — | — | set on GitHub now; unread until Phase 06; worker never receives webhooks |
| `REDIS_URL` | ✅ | ✅ | — | Phase 02/03 — installation-token cache, shared by both deployables |
| `WORKER_TEMP_DIR` | — | ○ | — | Phase 03 — tarball extraction scratch dir; defaults to a container-standard temp path |
| `INDEX_MAX_TOTAL_BYTES` | — | ○ | — | Phase 03 — zip-bomb defense; defaults to 2 GiB |
| `INDEX_MAX_FILE_COUNT` | — | ○ | — | Phase 03 — defaults to 200,000 |

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

| Environment | `AUTH_URL` | Registered callback URL |
|---|---|---|
| Local | `http://localhost:4000` | `http://localhost:4000/api/auth/callback/github` |
| Staging | `https://api-staging.example.com` | `https://api-staging.example.com/api/auth/callback/github` |
| Production | `https://api.example.com` | `https://api.example.com/api/auth/callback/github` |

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

| Frontend | API | Same site? | Cookie auth works? |
|---|---|---|---|
| `http://localhost:3000` | `http://localhost:4000` | yes (ports don't count) | ✅ |
| `https://app.example.com` | `https://api.example.com` | yes (`example.com`) | ✅ |
| `https://app.example.com` | `https://api.example.io` | **no** | ❌ sign-in appears to work, then every API call is 401 |
| `https://app.vercel.app` | `https://api.fly.dev` | **no** | ❌ same |

This is easy to get wrong when the two deployables land on different platforms' default
domains. **Put both behind subdomains of one registrable domain**, or the frontend will
sign in successfully and then be unable to call the API at all. `FRONTEND_URL` (CORS
origin, api) and `NEXT_PUBLIC_API_URL` (api origin, web) must point at that pair.

## Infrastructure

| Dependency | Used by | Since | Notes |
|---|---|---|---|
| PostgreSQL | `apps/api`, `apps/worker` | Phase 00 (worker: **Phase 03**) | The system of record. One database, two deployables. |
| Redis | `apps/api`, `apps/worker` | Phase 02 (worker: **Phase 03**) | Installation-access-token cache only. |

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

| | GitHub **OAuth App** (Phase 01) | GitHub **App** (Phase 02) |
|---|---|---|
| Answers | *Who is signed in?* | *What repository data may we read?* |
| Credentials | `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_SLUG` |
| Registered at | Developer settings → OAuth Apps | Developer settings → GitHub Apps |
| Used for | Sign-in, session | Every repository read and every review comment |

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
