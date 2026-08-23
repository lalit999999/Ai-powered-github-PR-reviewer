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

`apps/worker` has exactly one diagnostic function (`noop-handler`) until Phase 03 gives
it real work. Its container/Dockerfile is deliberately deferred to Phase 03 (phase-00 §18).

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
| `DATABASE_URL` | ✅ | — | — | also needed by the release-step `migrate deploy` |
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
