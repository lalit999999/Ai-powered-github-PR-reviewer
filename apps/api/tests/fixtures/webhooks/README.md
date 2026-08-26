# GitHub webhook fixtures — provenance

**These are schema-derived, not recorded**, the same situation
`packages/github/tests/fixtures/github/README.md` documents for the REST fixtures: this
environment has no real GitHub App, no real installation, and no real repository
(`docs/decisions/phase-02-log.md` §14/§29, carried forward through every later phase's
log), so there was no real delivery to capture. Stated here plainly, per phase-06 §0's
own provenance requirement, rather than left for someone to discover later.

## How these were built

Each file was hand-written against GitHub's **documented** webhook payload shapes for
the events this phase's schemas read (`pull_request`, `installation`,
`installation_repositories`, `repository`, `ping`). Every field
`webhook.schema.ts`'s schemas actually parse is present with a realistic value — GitHub's
own long-standing API-docs example repository (`octocat/hello-world`, id `1296269`) is
reused deliberately, matching the convention `packages/github`'s own fixtures already
established, so a reader who has seen one fixture corpus in this codebase recognizes the
other. Installation ids, pull request ids, and commit SHAs are fabricated but
realistic-magnitude/shaped values, distinguishable at a glance from anything that could
be a real credential or a real person's data — no real GitHub account, repository, or
installation was ever involved in producing these files.

Extra fields beyond what the schemas read (`user`, `title`, `body`, `merged_at`, ...) are
included where they make a fixture read as a real delivery rather than a minimal stub —
a judgment call, not an attempt at completeness, matching `packages/github`'s own
fixtures' stated approach.

## What each file is for

| File | Event | Action | Used by |
|---|---|---|---|
| `pull-request-opened.json` | `pull_request` | `opened` | dispatch path, fan-out, latency test |
| `pull-request-synchronize.json` | `pull_request` | `synchronize` | dispatch path (same PR, new head SHA) |
| `pull-request-edited.json` | `pull_request` | `edited` | metadata-only persistence, no dispatch |
| `pull-request-ready-for-review.json` | `pull_request` | `ready_for_review` | draft-exception dispatch |
| `pull-request-draft-opened.json` | `pull_request` | `opened`, `draft: true` | per-tenant draft gate |
| `pull-request-closed.json` | `pull_request` | `closed` | state-sync persistence, no dispatch |
| `installation-deleted.json` | `installation` | `deleted` | installation sync (Prompt 4) |
| `installation-repositories-removed.json` | `installation_repositories` | `removed` | installation sync (Prompt 4) |
| `repository-renamed.json` | `repository` | `renamed` | repository sync (Prompt 4) |
| `ping.json` | `ping` | — | acknowledgment path |

## Format

Every file is the **exact JSON body** GitHub would POST as `req.body` for that delivery —
not wrapped in a `{status, headers, body}` envelope the way `packages/github`'s REST
fixtures are, because a webhook fixture's entire job in this suite is to be signed and
sent as raw bytes (`webhook-helpers.ts`'s `postWebhook`), not read back as a client
response. `installation`/`installation_repositories`/`repository`/`ping` fixtures have no
`X-GitHub-Delivery`/`X-GitHub-Event` headers baked in — those are supplied by the test via
`postWebhook`'s options, matching how GitHub actually transmits them (as headers, never as
body fields).
