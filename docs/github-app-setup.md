# GitHub App registration runbook

This is the manual, one-time-per-environment setup for the **GitHub App** that Phase 02
introduces. Follow it once per environment (local, staging, production) — see
[One App per environment](#one-app-per-environment) for why sharing one does not work.

> **This is not the OAuth App.** Phase 01 registered a GitHub **OAuth App**, which
> answers _who is signed in_. This phase registers a GitHub **App**, which answers _what
> repository data we may read and where we may publish review comments_. They are two
> separate registrations with two separate credential sets and are never interchangeable
> — `plan.md` §45 names conflating them as a top failure point for this phase. You will
> end up with both, side by side, in every environment.

The rationale for each permission requested below — the version written for a customer
security review — lives in [`github-app-permissions.md`](./github-app-permissions.md).

---

## 1. Create the App

Go to **Settings → Developer settings → GitHub Apps → New GitHub App** (under your user
account for a personal test App, or under the organization that should own it).

| Field                                | Value                                                                                                                                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub App name**                  | Must be globally unique. Suffix it per environment, e.g. `gitprreviewer-staging`.                                                                                                                                                                  |
| **Homepage URL**                     | The deployed `apps/web` origin (locally: `http://localhost:3000`).                                                                                                                                                                                 |
| **Callback URL**                     | `$AUTH_URL/api/auth/callback/github` — the _same_ value the OAuth App uses. Only needed if "Request user authorization (OAuth) during installation" is ticked; leave that **unticked**, since sign-in already goes through the Phase 01 OAuth App. |
| **Setup URL** (optional)             | Where GitHub sends the user after they install. Point it at the projects page, e.g. `$FRONTEND_URL/projects`.                                                                                                                                      |
| **Webhook → Active**                 | ✅ **Yes.** Configure it now even though nothing receives it yet — see [The webhook 404s until Phase 06](#the-webhook-404s-until-phase-06).                                                                                                        |
| **Webhook URL**                      | `$API_ORIGIN/api/webhooks/github` (locally, a tunnel URL — see below).                                                                                                                                                                             |
| **Webhook secret**                   | Generate with `openssl rand -hex 32`. This becomes `GITHUB_APP_WEBHOOK_SECRET`.                                                                                                                                                                    |
| **Where can this App be installed?** | "Any account" if it will serve other users; "Only on this account" for a personal test App.                                                                                                                                                        |

## 2. Permissions

Under **Permissions → Repository permissions**, set exactly these and nothing else:

| Permission        | Access             | Why                                                                           |
| ----------------- | ------------------ | ----------------------------------------------------------------------------- |
| **Contents**      | **Read-only**      | Read source files for indexing and for assembling review context.             |
| **Pull requests** | **Read and write** | Read diffs and PR metadata; publish review comments (Phase 13).               |
| **Metadata**      | **Read-only**      | Mandatory baseline — GitHub sets this automatically and it cannot be removed. |

Leave **every** other repository permission at _No access_, and leave **all**
organization and account permissions at _No access_. Specifically never grant
`Contents: Read and write`, `Administration`, or `Actions` — a reviewer bot that can
write to repositories is a supply-chain attack surface (phase-02 §4 Security,
`plan.md` §35.1). The customer-facing version of this argument is in
[`github-app-permissions.md`](./github-app-permissions.md).

## 3. Subscribe to events

Under **Subscribe to events**, tick:

| Event                         | Needed by   | Notes                                                             |
| ----------------------------- | ----------- | ----------------------------------------------------------------- |
| `Installation`                | Phase 06    | App installed, uninstalled, suspended, unsuspended.               |
| `Installation repositories`   | Phase 06    | Repositories added to / removed from an existing installation.    |
| `Pull request`                | Phase 06/07 | Opened, synchronize, reopened, closed — the trigger for a review. |
| `Pull request review comment` | Phase 13    | Needed once the bot participates in review threads.               |

Nothing consumes any of these until Phase 06. Subscribing now means the App's
configuration does not have to be revisited then.

## 4. Download the private key

On the App's settings page, scroll to **Private keys → Generate a private key**. GitHub
downloads a `.pem` **once** — it cannot be retrieved again, only regenerated.

Convert it to the encoding this codebase expects:

```bash
base64 -w0 your-app-name.2026-08-24.private-key.pem
```

Paste the single-line output as `GITHUB_APP_PRIVATE_KEY`.

**Why base64.** The `.pem` is multi-line, and most `.env` loaders and hosting providers
mangle real newlines — the resulting "invalid key" error surfaces at the first GitHub
call, far from its cause. `apps/api` decodes and shape-checks the value at boot and
**refuses to start** if it is not a PKCS#1/PKCS#8 PEM, so a mangled key fails loudly in
the first second rather than during a user's first repository connect.

A raw multi-line PEM is also accepted (dotenv supports multi-line double-quoted values),
which is convenient locally. Deployments should use base64.

Both key formats GitHub emits work: `-----BEGIN RSA PRIVATE KEY-----` (PKCS#1, the
default download) and `-----BEGIN PRIVATE KEY-----` (PKCS#8).

## 5. Collect the environment variables

| Variable                    | Where to find it                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`             | App settings → **App ID** (a number; stored as a string — it is the JWT `iss` claim).                                                                                |
| `GITHUB_APP_SLUG`           | The last path segment of the App's public page, `https://github.com/apps/<slug>`. Used to build the install link `https://github.com/apps/<slug>/installations/new`. |
| `GITHUB_APP_PRIVATE_KEY`    | The base64 from step 4.                                                                                                                                              |
| `GITHUB_APP_WEBHOOK_SECRET` | The secret from step 1.                                                                                                                                              |
| `REDIS_URL`                 | Your Redis instance. Locally `redis://localhost:6379` via `docker compose up -d`.                                                                                    |

Put them in `apps/api/.env` locally (never committed) or the environment's secret store.
`.env.example` lists the names.

## 6. Install the App

Open `https://github.com/apps/<slug>/installations/new`, pick an account or organization,
and choose **Only select repositories** with two or three test repositories.

Installing is what creates an _installation_, which is what installation tokens are
minted against. The App existing is not enough — without an installation there is
nothing to authenticate as.

---

## The webhook 404s until Phase 06

The webhook is configured in Phase 02 but the receiving endpoint
(`/api/webhooks/github`) is not built until **Phase 06**. Between those two phases,
GitHub will attempt deliveries to a URL that returns 404, and the App's **Advanced →
Recent Deliveries** tab will show a column of red failures.

**This is expected and documented** (phase-02 §1), not a bug to debug. GitHub retries
failed deliveries, nothing in Phases 02–05 depends on delivery succeeding, and Phase 06
turns the same configuration live without any change here.

Until Phase 06 ships, installations are synced by an explicit `GET /user/installations`
call on page load rather than by webhook (phase-02 §10).

## One App per environment

A GitHub App has **one** webhook URL and **one** callback URL. Sharing a single App
across local, staging, and production sends every environment's events to whichever URL
was configured last — the same trap as the OAuth callback URL described in
[`deployment.md`](./deployment.md), and it fails the same confusing way.

Register a separate App per environment, with its own private key and its own webhook
secret.

## Local development and webhooks

`localhost` is not reachable from GitHub. Until Phase 06 there is nothing to receive
deliveries anyway, so the simplest local setup is to point the webhook URL at a
placeholder (`http://localhost:4000/api/webhooks/github`) and ignore the failures. When
Phase 06 arrives, front it with a tunnel (`cloudflared`, `ngrok`, or similar) and update
the App's webhook URL to the tunnel's hostname.

## A note on CI

**GitHub Actions secrets cannot start with `GITHUB_`** — that prefix is reserved. If
real App credentials are ever needed in CI, store them under different secret names and
remap them in the workflow's `env:` block. CI today uses dummy values and never contacts
GitHub.

## Verifying the setup

1. `apps/api` boots without a config error — the private key decoded and parsed.
2. `docker compose up -d` and `docker exec redisdb redis-cli ping` returns `PONG`.
3. The install link `https://github.com/apps/<slug>/installations/new` resolves.

End-to-end verification (installing on a real account and connecting a repository) needs
the routes and UI that Prompts 2 and 3 of this phase build.
