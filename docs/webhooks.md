# Webhook ingestion (Phase 06)

What `POST /api/webhooks/github` accepts, what it does with each event/action pair, the
`WebhookEvent` audit ledger's state machine, and where to make each kind of change. This
is the human-readable counterpart to
`apps/api/src/modules/webhooks/event-allowlist.ts` — that file is the one place in the
_code_ the allow-list lives; this is the one place in the _docs_.

## The event/action matrix

| `X-GitHub-Event`            | Action                                                  | Handling                                                                                                 | Where                    |
| --------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------ |
| `pull_request`              | `opened`, `reopened`, `synchronize`, `ready_for_review` | Dispatches `pull-request/review.requested` to Inngest                                                    | `event-router.ts`        |
| `pull_request`              | `closed`, `converted_to_draft`                          | Updates stored `PullRequest` state, no dispatch                                                          | `event-router.ts`        |
| `pull_request`              | `edited`                                                | Updates stored metadata only, never a re-review                                                          | `event-router.ts`        |
| `installation`              | `created`                                               | Updates an existing `GithubInstallation` row; **ignores** if none exists                                 | `installation-sync.ts`   |
| `installation`              | `deleted`                                               | Marks every repository under the installation `ACCESS_LOST`; the `GithubInstallation` row itself is kept | `installation-sync.ts`   |
| `installation`              | `suspend`                                               | Sets `suspendedAt`; marks repositories `ACCESS_LOST`                                                     | `installation-sync.ts`   |
| `installation`              | `unsuspend`                                             | Clears `suspendedAt`; restores `ACCESS_LOST` repositories to `ACTIVE`                                    | `installation-sync.ts`   |
| `installation_repositories` | `added`                                                 | No-op for connection status — see below                                                                  | `installation-sync.ts`   |
| `installation_repositories` | `removed`                                               | Marks the named repositories `ACCESS_LOST`, keyed by `githubRepoId`                                      | `installation-sync.ts`   |
| `repository`                | `renamed`                                               | Updates `owner`/`name`/`fullName`/`htmlUrl` on every connected project's row                             | `installation-sync.ts`   |
| `repository`                | `deleted`, `archived`                                   | Marks every connected project's row `ACCESS_LOST`                                                        | `installation-sync.ts`   |
| `repository`                | `unarchived`                                            | Restores `ACCESS_LOST` rows to `ACTIVE`                                                                  | `installation-sync.ts`   |
| `push`                      | — (all actions)                                         | Allow-listed, no handler — see below                                                                     | `event-allowlist.ts`     |
| `ping`                      | —                                                       | Acknowledged, no `WebhookEvent` row written                                                              | `webhooks.controller.ts` |

Anything not in this table is an **unknown event**: the response is still `200` (so
GitHub does not retry a delivery this server will never handle differently), a `warn` log
line is written with `outcome: "UNKNOWN_EVENT"`, and **no `WebhookEvent` row is written**
— `event-allowlist.ts`'s own header comment works through why "rejected" (§4 Security)
means "no row, no dispatch," not a non-2xx status.

### Why `push` is allow-listed with no handler

Out of scope §3 is explicit that emitting an event with zero consumers is unnecessary MVP
complexity — a later phase adds the emission and its first consumer together, so the
event contract and its reader are settled in the same change rather than one waiting on
the other. `push` is allow-listed today anyway, purely so a repository with an active
webhook does not generate "unknown event" log noise on every commit — GitHub sends a
`push` delivery for every push whether or not this system does anything with it. A `push`
delivery still gets a `WebhookEvent` row, marked `IGNORED` with reason
`PUSH_NOT_HANDLED_IN_MVP`.

### Why `installation_repositories.added` is a no-op

Connecting a repository to a project is an explicit user action through
`POST /api/projects/:id/repositories`. The GitHub App merely gaining _visibility_ into a
repository — because someone widened the installation's repository selection — does not
connect it to anything. Handled as its own branch in `installation-sync.ts` (not falling
through to a default) specifically so this reads as "deliberately does nothing," not a
gap nobody noticed.

### Deliberately out of scope: `issue_comment`, `pull_request_review_comment`

Neither is in the allow-list. Both are an **untrusted-input surface**: they carry
arbitrary text from arbitrary GitHub users (anyone who can comment on a public repository,
or any collaborator on a private one), which is a fundamentally different trust boundary
from every event this phase handles — `pull_request`, `installation`,
`installation_repositories`, and `repository` all originate from GitHub's own metadata
about actions taken through its UI/API, not from freeform user text. Handling comment
events needs its own authorization design (who may trigger what by commenting, how a
malicious comment body is treated) that this phase does not build. `pull_request_review_comment`
is subscribed on the App already (so the App configuration does not need revisiting when
a later phase adds handling) but is not allow-listed, so a delivery for it today is logged
as an unknown event and produces no row — exactly the same treatment as any other
unrecognized event type.

## The `WebhookEvent` state machine

```
                 insertPending
                      │
                      ▼
                  PENDING ──────────────┐
                 ╱    │    ╲            │
     dispatch    ╱     │     ╲   sweep re-dispatch (webhook-sweeper, apps/worker)
     succeeds   ╱      │      ╲         │
               ▼       │       ▼        │
         DISPATCHED     │    FAILED ◄───┘ (unsweepable dispatchPayload)
                        │
                        ▼
                    IGNORED
        (allow-listed, acted on if applicable, no dispatch —
         pull_request.edited/closed, installation/installation_repositories/
         repository sync, ping/push)
```

Four states, pinned as `WebhookEventStatus` in `@repo/shared`'s `webhooks.ts` — a plain
`String` column, not a Postgres enum, matching the same asymmetry
`Repository.connectionStatus` already has (see that model's own schema comment):

- **`PENDING`** — the row is inserted before anything else happens (the dedup gate).
  Dispatch has not yet been attempted, or was attempted and failed — either way, this is
  the sweeper's retry target.
- **`DISPATCHED`** — the Inngest send for a `pull_request` review-triggering delivery
  succeeded.
- **`IGNORED`** — allow-listed, acted on where applicable (a `PullRequest` row updated, an
  installation/repository sync applied), but no Inngest dispatch was ever the point of
  this delivery. `pull_request.edited`/`closed`/`converted_to_draft`, `ping`, `push`, and
  every `installation`/`installation_repositories`/`repository` sync delivery all resolve
  here — a sync delivery is never `DISPATCHED`, because syncing installation/repository
  state was never a dispatch decision in the first place (§11's four-state vocabulary
  stays fixed; a sync outcome does not get a fifth state).
- **`FAILED`** — terminal, for a condition retrying can never fix: a
  malformed-but-authentically-signed payload (`MALFORMED_PAYLOAD`), or a `PENDING` row the
  sweeper found with a null/unparseable `dispatchPayload` (`UNSWEEPABLE_DISPATCH_PAYLOAD`)
  — the exact shape a crash between `insertPending` and `savePendingDispatchPayload`
  would leave behind.

**A delivery never moves `IGNORED`/`FAILED` → anything else**, and never moves
`DISPATCHED` → anything else. Only `PENDING` has outgoing edges.

## Deduplication and fan-out

- **Dedup** is the `deliveryId` unique constraint on `WebhookEvent`, enforced by the
  database, not a pre-check `SELECT` — a pre-check races under concurrent redelivery,
  the constraint does not.
- **Fan-out**: one GitHub repository connected to two different projects produces **two**
  independent `WebhookEvent`-driven outcomes from **one** delivery — `event-router.ts`
  loops over every tenant `findConnectedByGithubRepoId` resolves, one `PullRequest` upsert
  and (if triggering) one dispatched event per tenant, never one event carrying two ids.
  The installation/repository sync functions in `installation-sync.ts` are similarly
  `githubRepoId`-wide or `installationId`-wide by construction — a `repository.renamed`
  delivery updates every project's copy of that repository in one statement, not per
  tenant.

## The thin-handler rule, enforced mechanically

Nothing under `apps/api/src/modules/webhooks/**` may import `@repo/github` (or reach past
its public index into `packages/github/src/**`) — ESLint's Rule D
(`eslint.config.mjs`), backed by `apps/api/src/lib/boundaries.test.ts`. This endpoint
makes **zero outbound GitHub API calls** on any path: every field it needs is already in
the payload GitHub sent. A well-meaning future change ("just fetch the PR's base branch
here to enrich the event") is exactly the regression this rule exists to catch at lint
time, not in review.

## How to add a new triggering action

1. Add the action to the right array in `event-allowlist.ts`'s matrix (e.g. widen
   `REVIEW_TRIGGERING_ACTIONS` to include a new `pull_request` action).
2. Branch on it in the matching router/sync function — `event-router.ts` for
   `pull_request`, `installation-sync.ts` for the other three event types.
3. Add a test for the new branch (`event-router.test.ts` or `installation-sync.test.ts`).

If this list ever grows past three steps, the seam `event-allowlist.ts` was built to be —
one matrix, read by one router per event type — has stopped doing its job, and that is
worth fixing before adding the fourth step.

## `GITHUB_APP_WEBHOOK_SECRET` rotation

The secret authenticates every delivery via an HMAC-SHA256 over the raw request body
(`webhook-verification.ts`); there is no other authentication on this route (see
`webhooks.controller.ts`'s own header comment for why that is correct, not an oversight).

**What a spike in signature rejections means operationally.** Every failed verification
is logged at `warn` with a dedicated `outcome: "SIGNATURE_REJECTED"` value and a `reason`
— queryable independently of every other rejection reason, specifically so a spike here
is distinguishable from ordinary noise. A sustained spike means one of:

- The secret was rotated on GitHub's App settings page but the deployment's
  `GITHUB_APP_WEBHOOK_SECRET` was not updated to match (the common case — check this
  first).
- The secret leaked and is being used to forge deliveries. `packages/db`'s
  `WebhookEvent` table gets no row for a rejected signature (rejection happens before
  `insertPending`), so the record of an attack attempt lives only in this log line —
  export/alert on `outcome: "SIGNATURE_REJECTED"` if this needs to page anyone.

**To rotate**: generate a new secret (`openssl rand -hex 32`), set it in the App's
webhook settings _and_ redeploy `apps/api` with the matching
`GITHUB_APP_WEBHOOK_SECRET` in the same maintenance window — GitHub signs every
delivery with whatever secret is currently configured, so there is no overlap window
where both old and new secrets are simultaneously valid.

## Rate limiting

`webhook-rate-limit.ts`'s `WEBHOOK_RATE_LIMIT_PER_INSTALLATION` (100 deliveries per
`WEBHOOK_RATE_LIMIT_WINDOW_SECONDS`, 60s), scoped per installation — see that file's own
header comment for the numbers' derivation. A rate-limited request is answered `200` (not
`429`), and no `WebhookEvent` row is written for it — a `429` would only teach GitHub to
retry a delivery this guard exists to shed.

## The sweeper

`apps/worker/src/inngest/functions/webhook-sweeper.ts` — a `* * * * *` cron that finds
`WebhookEvent` rows stuck `PENDING` for at least 60 seconds (two orders of magnitude past
`emit.ts`'s own 300ms Inngest-send timeout, so nothing still inside its own request
lifecycle is ever mistaken for stuck) and re-sends each one's stored `dispatchPayload`
verbatim — never re-derived, since tenant resolution could legitimately produce a
different fan-out by sweep time. Bounded to 50 rows per tick so a long outage drains
incrementally across ticks instead of timing out one oversized sweep. See that file's own
header comment for the full argument, including why re-sending is safe (the `prKey`
Inngest-level dedup `emit.ts` already sets).

## Where the code lives

```
apps/api/src/modules/webhooks/
  event-allowlist.ts        the one matrix — event/action → handling category
  event-router.ts           pure pull_request routing decision (dispatch/persist/ignore)
  installation-sync.ts      installation/installation_repositories/repository sync
  webhook-verification.ts   HMAC signature verification
  webhook-rate-limit.ts     the per-installation burst guard's tuning constants
  webhook-event.repository.ts   WebhookEvent Prisma access (apps/api side)
  pull-request.repository.ts    minimal PullRequest upsert
  webhook.schema.ts         Zod schemas for the payload subset this phase reads
  webhook.service.ts        orchestration: dedup → parse → route/sync → dispatch → status
apps/api/src/controllers/webhooks.controller.ts   POST /api/webhooks/github
apps/worker/src/webhooks/webhook-event.repository.ts   WebhookEvent Prisma access (apps/worker side)
apps/worker/src/inngest/functions/webhook-sweeper.ts   the retry cron
apps/web/src/components/repository/webhook-status-panel.tsx   the recent-deliveries UI
```
