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

<<<<<<< HEAD
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
=======
| Field | Value |
|---|---|
| **GitHub App name** | Must be globally unique. Suffix it per environment, e.g. `gitprreviewer-staging`. |
| **Homepage URL** | The deployed `apps/web` origin (locally: `http://localhost:3000`). |
| **Callback URL** | `$AUTH_URL/api/auth/callback/github` — the *same* value the OAuth App uses. Only needed if "Request user authorization (OAuth) during installation" is ticked; leave that **unticked**, since sign-in already goes through the Phase 01 OAuth App. |
| **Setup URL** (optional) | Where GitHub sends the user after they install. Point it at the projects page, e.g. `$FRONTEND_URL/projects`. |
| **Webhook → Active** | ✅ **Yes.** Phase 06 built the receiving endpoint — see [Webhook delivery](#webhook-delivery). |
| **Webhook URL** | `$API_ORIGIN/api/webhooks/github` (locally, a tunnel URL — see below). |
| **Webhook secret** | Generate with `openssl rand -hex 32`. This becomes `GITHUB_APP_WEBHOOK_SECRET`. |
| **Where can this App be installed?** | "Any account" if it will serve other users; "Only on this account" for a personal test App. |
>>>>>>> main

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

<<<<<<< HEAD
| Event                         | Needed by   | Notes                                                             |
| ----------------------------- | ----------- | ----------------------------------------------------------------- |
| `Installation`                | Phase 06    | App installed, uninstalled, suspended, unsuspended.               |
| `Installation repositories`   | Phase 06    | Repositories added to / removed from an existing installation.    |
| `Pull request`                | Phase 06/07 | Opened, synchronize, reopened, closed — the trigger for a review. |
| `Pull request review comment` | Phase 13    | Needed once the bot participates in review threads.               |
=======
| Event | Needed by | Notes |
|---|---|---|
| `Installation` | Phase 06 | App installed, uninstalled, suspended, unsuspended — handled live. |
| `Installation repositories` | Phase 06 | Repositories added to / removed from an existing installation — handled live. |
| `Pull request` | Phase 06/07 | Opened, synchronize, reopened, closed — Phase 06 dispatches the event, Phase 07 reviews. |
| `Pull request review comment` | Phase 13 | Subscribed now; not yet handled — see `docs/webhooks.md`'s "deliberately out of scope" section. |
>>>>>>> main

Every event above except `Pull request review comment` has a live handler as of Phase 06
— see [`docs/webhooks.md`](./webhooks.md) for the full event/action matrix.

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

## Webhook delivery

The webhook is configured in Phase 02, and the receiving endpoint
(`POST /api/webhooks/github`) was built in Phase 06 — point the **Webhook URL** at
`$API_ORIGIN/api/webhooks/github` and deliveries are received, verified, and either
dispatched or synced. See [`docs/webhooks.md`](./webhooks.md) for the full event/action
matrix, the `WebhookEvent` audit ledger, and what a spike in signature-rejection logs
means operationally.

Historical note, for anyone reading an old deployment's **Advanced → Recent Deliveries**
tab: between Phase 02 (webhook configured) and Phase 06 (endpoint built), deliveries
against this URL 404'd. That was expected and documented at the time (phase-02 §1), not a
bug — GitHub retries, and nothing in Phases 02–05 depended on delivery succeeding.

`GET /api/github/installations`'s page-load sync (phase-02 §10) is no longer standing in
for the missing webhook receiver — it is now the **attribution** path only (which signed-in
user owns an installation); see `docs/webhooks.md` and `installation-sync.ts`'s own header
comment for why a webhook payload alone can never answer that question.

## One App per environment

A GitHub App has **one** webhook URL and **one** callback URL. Sharing a single App
across local, staging, and production sends every environment's events to whichever URL
was configured last — the same trap as the OAuth callback URL described in
[`deployment.md`](./deployment.md), and it fails the same confusing way.

Register a separate App per environment, with its own private key and its own webhook
secret.

## Local development and webhooks

`localhost` is not reachable from GitHub, so real deliveries need a tunnel
(`cloudflared`, `ngrok`, or similar) in front of `apps/api`, with the App's webhook URL
pointed at the tunnel's hostname plus `/api/webhooks/github`. Without a tunnel, the
simplest local setup is to leave the webhook URL at a placeholder
(`http://localhost:4000/api/webhooks/github`) and ignore the resulting delivery failures
— `docs/webhooks.md`'s §14 verification steps show what to insert directly via Prisma to
exercise the sweeper and the panel without a real delivery at all.

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
