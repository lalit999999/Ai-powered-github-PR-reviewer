# Phase 03 — Prompt 1 Decision Log

Records the judgment calls made implementing **Prompt 1** of Phase 03 (foundation, worker
deployable, tarball fetcher, archive extractor). Same convention as
`phase-00-log.md`/`phase-01-log.md`/`phase-02-log.md`: this file records what was decided
*and* what could not be verified from this environment. Prompt 2 and Prompt 3 build on
this; entries here are binding for that work.

## 0. Inherited baseline (verified before writing any Phase 03 code)

Every command run against the tree as inherited from `main` (`d3e97f7`, the merge of
`phase-02-git-repo-integration`), before a single line was changed:

| Command | Result |
|---|---|
| `pnpm install` | Clean — "Already up to date", 6 workspace projects |
| `pnpm db:generate` | Prisma Client 7.9.1 generated to `packages/db/src/generated` |
| `pnpm lint` | Pass, 0 errors (`turbo lint` + the root boundary/no-console config) |
| `pnpm typecheck` | Pass — 3 tasks (`api`, `web`, `worker`) |
| `pnpm test:unit` | Pass — **20 files, 377 tests** |
| `pnpm test:integration` | Pass — **7 files, 99 tests** (Testcontainers Postgres; Docker was available in this environment — see below) |
| `pnpm build` | Pass — 3 tasks |
| `prisma migrate status` | "Database schema is up to date!", 3 migrations found |

**Nothing was red.** `pnpm format:check` was not re-run — it was already known-failing
per `phase-02-log.md` §13/§43 (a `prettier.config.js`/`.prettierrc` conflict predating
this phase), and re-confirming an already-documented, already-triaged failure would not
have added information.

**Docker was available in this environment**, unlike some earlier phases' sessions —
this matters because it means every claim in this log about the extractor's real
filesystem behavior, the migration applying to a fresh Testcontainers database, and the
Docker image actually building and booting is a **verified fact**, not a "would have
been nice to check." Where something still could not be verified (a real GitHub App, a
real hosting platform), that is called out explicitly rather than implied.

Branch: `phase-03-repository-indexing`, created fresh off `main` (no prior branch for
this phase existed).

## 1. Installed versions and behavior — read, not assumed

Per this repository's established practice (`phase-01-log.md` §1, `phase-02-log.md` §1),
everything below was verified by reading the installed package's own source, or by
running a throwaway script against it, not from memory or documentation.

| Package | Version | What was verified, and where |
|---|---|---|
| `@octokit/request` | 10.0.15 | `fetch-wrapper.js`: `requestOptions.request.redirect` **is** forwarded to the underlying `fetch` (an initial assumption that it wasn't wrong — see §8); a 3xx response resolves normally (not thrown) with no special-casing; the default response-body path calls `response.arrayBuffer()` for a non-JSON/`text/*` content type unless `request.parseSuccessResponseBody: false` is set. |
| `tar-stream` | 3.2.0 | `extract.js`: `Extract` is simultaneously a `Writable` and an async-iterable; each `entry` event/iteration yields `(header, stream, callback)` with **no filesystem interaction anywhere in the package** — confirmed by reading the full source, not just the README. `header.type` is one of `file | link | symlink | directory | block-device | character-device | fifo | contiguous-file | pax-*` (per `@types/tar-stream@3.1.4`, which the package itself does not ship). |
| `tar-fs` | 2.1.5, 3.1.3 (transitive, via Testcontainers) | Read enough of its README/exports to confirm it extracts *to the filesystem itself* (its whole purpose) — considered and rejected; see §9. |
| `tar` (node-tar) | 7.5.22 (transitive) | Same treatment — a complete extractor with its own internal path-safety logic, considered and rejected for the same "no seam to inspect before it acts" reason. |
| Node.js | 22.23.1 | `fetch(url, { redirect: "manual" })` resolves with the 3xx response and a readable `Location` header (`type: "basic"`, not the browser's opaque-redirect behavior) — verified empirically against a local HTTP server, not assumed from the fetch spec. `fetch(url, { redirect: "error" })` on an actual redirect rejects with `TypeError: fetch failed`, also verified empirically. `Readable.fromWeb()` exists and works; its TypeScript signature is declared against `node:stream/web`'s `ReadableStream`, a nominally distinct type from the DOM-lib global of the same name that `fetch()` and this phase's own code use, requiring a cast (see `archive-extractor.ts`). |
| `turbo` | 2.10.11 | `turbo prune <scope> --docker` — ran it directly against this repo (`turbo prune worker --docker`) and inspected the output: `out/json/` (pruned `package.json`s + lockfile) and `out/full/` (pruned real source), scoped to exactly `@repo/db`, `@repo/github`, `@repo/observability`, `@repo/shared`, `worker` for the `worker` scope — nothing from `apps/api`/`apps/web` included. Does **not** carry along the workspace-root `tsconfig.json` even though every pruned package's own `tsconfig.json` extends it — verified by inspecting `out/full/`'s contents directly, not assumed. |
| Prisma | 7.9.1 | The `prisma-client` generator's `moduleFormat`/`importFileExtension` options exist and are accepted (found by grepping the installed `prisma` CLI's own minified `build/cli.js` for the option names propagating through its internal generator pipeline, then confirmed empirically by setting them and re-running `prisma generate`) — see §12. The generated client's own internal relative imports (e.g. `./internal/class`) ship **without** an extension by default and carry `// @ts-nocheck`, which is why the missing extension never surfaced as a *type* error, only as a runtime `ERR_MODULE_NOT_FOUND` once the client was actually compiled and run rather than read as source. |
| `@auth/prisma-adapter` | 2.11.3 | `index.d.ts`: `PrismaAdapter()` imports `Adapter` from `@auth/core/adapters` internally but does not re-export it — confirmed by reading the shipped `.d.ts` directly, which is why `packages/db/src/auth-adapter.ts` needed its own explicit `@auth/core` dependency once it started emitting its own declaration files (see §12). |

## 2. Sub-task 1.1 — promoting the GitHub client: the options actually weighed

The phase document's own framing (echoed in this prompt) named three options. Recorded
here with the reasoning that decided between them, since this is the largest
architectural call in the prompt.

**Option C (apps/worker depends on apps/api as a workspace package) was rejected
immediately** — it would drag Express, Auth.js, and every apps/api-only concern into the
worker's build for no benefit, and directly contradicts §1's entire premise that the
worker is a *separate* deployable.

**Option B (a worker-local thin GitHub module) was rejected** — it would either
duplicate token minting/the ETag/throttle/retry stack (a second copy of exactly the logic
`phase-02-log.md` §12 spent real effort getting right: the 401-vs-403-with-headers
disambiguation, the 50-minute cache TTL reasoning, the retry taxonomy) or construct a
second Octokit, which `phase-02-log.md` §16 forbids by name ("Reuse it; do not construct
a second Octokit anywhere"). Neither is "contained" duplication — token-mint retry logic
is exactly the kind of thing that silently drifts between two copies.

**Option A (promote to `packages/github`) was chosen**, and the prompt's own framing —
that this requires *also* promoting the shared observability primitives rather than
duplicating a logger a third time — turned out to be not just cleaner but load-bearing
for correctness. See §3.

The move itself: `git mv apps/api/src/github packages/github/src` (whole-directory move,
history preserved), plus `git mv apps/api/tests/fixtures/github
packages/github/tests/fixtures/github` (the fixture corpus `github-fixtures.test.ts`
loads — its only consumer, confirmed by grep before moving it). Every one of the five
named test files (`app-auth.test.ts`, `octokit-factory.test.ts`, `token-cache.test.ts`,
`github-fixtures.test.ts`, `github-services.test.ts`) passes unmodified except import
paths — the diff to each is exactly the import-line changes documented in §4/§5 below,
verified by running them (127 tests, 7 files, all green) before the sub-task's commit.

### The package boundary: what's public, what stays internal

`packages/github/src/index.ts` exports: `initGithubClient` / `getGithubClientConfig` /
`resetGithubClientConfigForTesting` / `githubAppPrivateKeySchema` /
`githubRedisUrlSchema` (config, §5); `GithubAccessRevokedError` / `GithubRateLimitError`
/ `ServiceUnavailableError` / `GithubClientError` (errors, §4); `getInstallationToken` /
`invalidateInstallationToken` (token minting); `createInstallationOctokit` /
`createUserOctokit` / `GITHUB_CLIENT_COMPONENT` (the factory); `classifyGithubError` /
`hasRateLimitHeaders` / `statusOf` / `GithubResult` / `GithubFailureReason` (the result
vocabulary); and `installationGithub` / `repositoryGithub` as **namespace** re-exports
(`export * as X from "./services/X.github.js"`), plus `BranchProbeResult` /
`GithubRepositoryMetadata` / `GithubInstallationSummary` /
`InstallationRepositorySummary` named directly as types. The namespace-export shape was
chosen specifically to minimize the diff at existing call sites: `repository.service.ts`
went from `import * as repositoryGithub from "../../github/services/repository.github.js"`
to `import { repositoryGithub } from "@repo/github"`, with every other line in the file
(`repositoryGithub.getRepository(...)`) untouched.

**Not exported**: `MAX_RATE_LIMIT_WAIT_SECONDS` — it exists as two, unrelated,
same-named constants in `app-auth.ts` and `rate-limiter.ts` (a pre-existing duplication,
not introduced here) which would collide if both were re-exported from one barrel;
neither was ever imported from outside its own file, so simply not surfacing either
avoids the collision entirely rather than picking a side.

### ESLint Rule A: the fixture had to change shape, not just location

Rule A's second pattern group (`**/src/github/**`, `**/github/client/*`,
`**/github/services/*`) existed specifically to catch a *relative* import bypassing the
package-name check, because Phase 02 put the client inside `apps/api` where no
package-name pattern could see it (`phase-02-log.md` §10). Once the client is a real
package, that specific hole is closed by the *first* pattern group (`@repo/github`
already listed there since Phase 00's forward declaration) — but a route could still
reach *past* `@repo/github`'s public `index.ts` into its internals via a long relative
path. Added `**/packages/github/src/**` to the same pattern group for that narrower case,
and rewrote `rule-a-github-tree-violation.ts` to demonstrate exactly that (a deep
relative import into `packages/github/src/client/octokit-factory.js`) rather than the
now-nonexistent `apps/api/src/github/**` path. `boundaries.test.ts` still fails on it —
confirmed by running the suite, not just by inspection of the pattern.

## 3. Sub-task 1.1 — the observability consolidation is a correctness requirement, not tidiness

`apps/worker`'s `lib/{logger,tracing}.ts` were a deliberate, time-boxed duplicate of
`apps/api`'s own copies (`phase-01-log.md` §9) — and had already drifted: the worker's
copy was missing the Phase 02 redaction rules (`token`/`accessToken`/`privateKey`-shaped
keys), which matters specifically *now*, the first phase where the worker mints and
holds a GitHub installation token.

But the reason this had to be fixed **before**, not alongside, the GitHub client's move
is sharper than redaction-rule drift: `tracing.ts`'s `AsyncLocalStorage` instance is a
**module-level singleton**. If `packages/github` had its own copy of `tracing.ts` (a
third copy, as a worker-local fix would have produced), then `getTraceContext()` called
from inside the GitHub client would read from a *different* `AsyncLocalStorage` instance
than the one `apps/api`'s request wrapper (or `apps/worker`'s Inngest middleware)
populated — every GitHub-client log line would silently lose `traceId`/`userId`/
`repositoryId` correlation, permanently, with no error to notice it by. This is not an
architectural nicety; it is the specific mechanism that makes cross-package log
correlation possible at all, and it only works if there is exactly one `tracing.ts` in
the whole dependency graph.

`packages/observability` (`@repo/observability`) was created holding `logger.ts` +
`tracing.ts`, moved verbatim from `apps/api/src/lib/` (the more complete copy, with the
Phase 02 redaction fix already in it) via `git mv`. `apps/worker`'s own
`lib/{logger,tracing}.ts` were deleted (`git rm`) rather than kept as a second option —
having chosen the shared module, a second copy sitting unused is a footgun for the next
person who edits the wrong one.

**Consequence, checked directly**: the existing `logger.test.ts` assertion —
`accessToken: "ghs_installationtoken"` → `[REDACTED]` — now runs against the *one* logger
both deployables use, so sub-task 1.2's "port the redaction rules and add a test"
requirement was satisfied by construction, not by writing a second test. Recorded as
"nothing further needed" in that sub-task's commit rather than silently skipped.

### The mocking fallout, and why `importOriginal` matters here specifically

Several existing unit/integration tests did `vi.mock("../../lib/logger.js", () => ({
createLogger: () => logSpies }))` — a **narrow** mock returning only `createLogger`. Once
logger and tracing became the same module (`@repo/observability`), a narrow mock like
that silently nulls out every *other* export from that module for the whole test file's
module graph — including `generateTraceId`/`runWithTraceContext`, which `http.ts` (via
`requestContext`) genuinely needs at runtime. This was not theoretical: fixing it
mechanically first and running the suite caught it immediately in
`repositories.routes.test.ts` (exercises `requestContext`/`errorHandler` for real) and in
`tenant-access.test.ts` (does a real, unmocked `await import("../tracing.js")`
expecting the actual functions). Every such mock was rewritten to the
`vi.mock("@repo/observability", async (importOriginal) => ({ ...(await
importOriginal()), createLogger: () => logSpies }))` shape — preserve everything real,
override just the one thing the test cares about. Six files needed this (`emit.test.ts`,
`tenant-access.test.ts`, `project.service.test.ts`, `repository-validation.service.test.ts`,
`repository.service.test.ts`, `repositories.routes.test.ts`), plus the two integration
tests that mock `@repo/github` similarly and transitively need `@repo/observability`
through it (`cross-tenant.test.ts`, `repositories.test.ts`).

### A latent bug this refactor exposed, unrelated to the refactor's own correctness

`project.service.test.ts` mocks `./project.repository.js` and `../../inngest/emit.js`,
with a comment claiming "neither `@repo/db` nor the config module is ever loaded here."
That was already false before this phase touched the file: `project.service.ts`
statically imports `repositoryService` from `../repositories/repository.service.js`,
which (via `installation.repository.ts`/`repository.repository.ts`) reaches `@repo/db`'s
`prisma` singleton — unmocked. This had never failed before because *some other* test
file sharing the same vitest worker thread happened to load `apps/api/src/config/env.ts`
(and its `import "dotenv/config"` side effect) first, leaving `DATABASE_URL` populated in
that worker's `process.env` for the rest of its run — pure scheduling luck, not a
guarantee. This phase's changes shifted file-collection timing enough to expose it (the
failure reproduced in both an isolated single-file run and, intermittently depending on
worker assignment, the full suite). Fixed properly — mocked `../repositories/
repository.service.js` in `project.service.test.ts`, the actual missing seam — rather
than chased away by re-ordering something incidental. Flagged here because it is exactly
the kind of pre-existing fragility that is "not yours to fix" in general, except that
touching adjacent code is precisely what surfaced it, and leaving a newly-flaky test
behind would have been worse than the two-line fix.

## 4. Sub-task 1.1 — the deliberate `ServiceUnavailableError` name collision

`packages/github/src/errors.ts` defines its own `GithubClientError` base (not
`apps/api`'s `AppError`) and its own `ServiceUnavailableError` extending it — the same
class *name* `apps/api/src/lib/errors.ts` already uses for an unrelated, HTTP-envelope-
shaped concept. This was a deliberate choice, not an oversight, argued fully rather than
just declared:

- `AppError` carries `httpStatus`/`toEnvelope()` — HTTP-response concerns that belong to
  `apps/api` specifically. A package cannot depend on the app that consumes it (that is
  Option C from §2, rejected), so `@repo/github` cannot extend `AppError`.
- Every live code path from `app-auth.ts`'s throw to a caller passes through
  `github-result.ts`'s `classifyGithubError`, which duck-types on `error.status` /
  `error.response.headers` — never `instanceof`. So the two `ServiceUnavailableError`
  classes are never compared against each other anywhere in the codebase; the shared name
  is cosmetic, not a type-safety hazard.
- `apps/api`'s own `ServiceUnavailableError` (used in `repository.service.ts`,
  `repository-validation.service.ts` when a `GithubResult` comes back `UNAVAILABLE`) was
  left **completely untouched** — same class, same file, same behavior. Only
  `GithubAccessRevokedError`/`GithubRateLimitError` were removed from
  `apps/api/src/lib/errors.ts`, since nothing outside the (now-moved) GitHub tree ever
  imported them from there.
- `apps/api/src/lib/errors.test.ts`'s parameterized cases for the two removed classes
  moved to `packages/github/src/errors.test.ts`, **not** copied — they now assert
  `instanceof GithubClientError` instead of `instanceof AppError`/`instanceof
  ForbiddenError`, because those latter two assertions stopped being true the moment the
  classes stopped extending `AppError`, and pretending otherwise would have been a
  passing test asserting something false.

## 5. Sub-task 1.1/1.2 — config: an `initGithubClient()` seam, not `process.env` in the package

`packages/github/src/config.ts` never reads `process.env`. It exports the private-key
transform (`githubAppPrivateKeySchema`, moved verbatim from `apps/api/src/lib/config.ts`
— same regexes, same transform, same refine, same error message) and the Redis-URL
scheme check (`githubRedisUrlSchema`) as reusable Zod schemas, plus `initGithubClient(config)`
/ `getGithubClientConfig()` / `resetGithubClientConfigForTesting()`. Each consuming app's
own `config/env.ts` calls `initGithubClient({ appId, privateKey, redisUrl })` once, right
after its own `loadConfig()` succeeds — so each app keeps its own fail-fast-at-boot
property, and the package has no way to boot successfully with a value neither app ever
validated.

**Verified this is safe against the existing test suite before relying on it**: every
existing test that exercises `app-auth.ts`/`octokit-factory.ts` injects `createAppJwt`/
`getToken`/`cache`/`etagStore` explicitly (confirmed by reading every call site in
`app-auth.test.ts`, `octokit-factory.test.ts`, `github-fixtures.test.ts`) — none of them
ever reach the *default*, config-reading code paths this seam replaced. No test needed to
change to accommodate this.

`apps/worker/src/lib/config.ts` gained `DATABASE_URL` (required — Rule B confines
*queries* to `*.repository.ts` files, but `packages/db/src/client.ts` reads
`DATABASE_URL` at import time, process-wide, exactly as `apps/api` already does),
`GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` (sharing `@repo/github`'s schema) and
`REDIS_URL` (sharing `@repo/github`'s schema) — **not** `GITHUB_APP_SLUG` or
`GITHUB_APP_WEBHOOK_SECRET`, since the worker never builds an install link and never
receives a webhook. Also gained the three §19 indexing-limit variables
(`WORKER_TEMP_DIR` optional; `INDEX_MAX_TOTAL_BYTES` default `2 * 1024**3`;
`INDEX_MAX_FILE_COUNT` default `200_000`). `loadConfig()`'s error message was upgraded to
carry each field's first Zod message (matching `apps/api`'s own upgrade from
`phase-02-log.md` §2) — otherwise a malformed `GITHUB_APP_PRIVATE_KEY` in the worker
would report identically to a missing one, the exact failure mode that upgrade already
fixed once on the API side.

**Verified live**, not just by unit test: booted `apps/worker` directly (`node
dist/server.js` after this phase's build fix, §12) against real `docker compose`
Postgres/Redis and placeholder-but-syntactically-valid GitHub App credentials (the same
placeholders `apps/api/.env` already uses, documented there as non-secret) — it starts
cleanly. Separately booted it with every required variable stripped — it fails fast,
naming every missing/invalid variable in one line:
`DATABASE_URL (DATABASE_URL is required), GITHUB_APP_ID (GITHUB_APP_ID is required),
GITHUB_APP_PRIVATE_KEY (GITHUB_APP_PRIVATE_KEY is required), REDIS_URL (REDIS_URL must
be a URL, e.g. redis://localhost:6379)`.

## 6. Sub-task 1.3 — RepositoryFile/IndexJob type vocabulary lives in `@repo/shared`, not an app-local types module

The sub-task's own instruction was to "pin the legal `indexState` values as a TypeScript
union in a types module, matching the `Repository.connectionStatus` precedent." The
precedent (`apps/api/src/modules/repositories/repository.types.ts`) puts the union in
`apps/api` because `connectionStatus` is an `apps/api`-only concept — nothing else ever
reads or writes it. `RepositoryFile.indexState`/`skipReason`/`parseState` and
`IndexJob.status`/`mode` are the opposite: `apps/worker` **writes** them (during
indexing, Prompt 2) and `apps/api` **reads** them (the `/index-status` endpoint, Prompt
2). That is a genuine cross-deployable contract, which is exactly the reason
`packages/shared` exists at all (`phase-01-log.md` §14, for the Inngest event registry)
— "an event contract is exactly the thing that must not drift" applies identically to a
state-vocabulary contract. `packages/shared/src/indexing.ts` was added rather than
reaching for `apps/api`'s module, and rather than inventing a second shared package for
a second kind of contract.

Six unions/functions: `INDEX_STATES` (`INDEXED | SKIPPED | FAILED`, §6's own comment),
`SKIP_REASONS` (six values — see §7), `PARSE_STATES` (a **single-value** union, see
below), `INDEX_JOB_STATUSES` (`PENDING | RUNNING | SUCCEEDED | FAILED`),
`INDEX_JOB_MODES` (`FULL | INCREMENTAL` — both values now, unlike `PARSE_STATES`, because
§6's own comment already names the complete vocabulary, not just this phase's reachable
subset), and `INDEX_ERROR_CODES` (four values this phase's own steps can produce — see
§8/§9).

**`ParseState` is deliberately the single literal `"OK"`, not `string`.** Every file that
reaches the hashing step this phase is, by construction, "parseable" in the sense this
phase can check (parsing itself doesn't exist until Phase 04). Typing it as the narrow
literal rather than `string` means Phase 04 introducing `"FAILED"` (plan.md §8.2 step 7)
is a **compile error at every call site**, the same forcing-function
`RepositoryDetail.indexJob: null` already uses to make Phase 03 widen it deliberately
(`phase-02-log.md` §26). Phase 04 owns the real vocabulary; this phase does not guess at
it.

## 7. Sub-task 1.3 — `skipReason`'s vocabulary, settled now because Prompt 2 depends on it

§12 names `SKIPPED_TOO_LARGE` explicitly and implies the rest of the filter pipeline's
stages (plan.md §8.2 step 4: hard-ignore globs → `.gitattributes` generated/vendored →
size cap → binary detection → minified heuristic). Pinned as
`SKIPPED_HARD_IGNORE | SKIPPED_GENERATED | SKIPPED_VENDORED | SKIPPED_TOO_LARGE |
SKIPPED_BINARY | SKIPPED_MINIFIED` — a fixed union, not free text, because Prompt 2's
filter pipeline needs something to assign *from*, and a downstream phase branching on
`skipReason` needs it machine-comparable. Every value follows `indexError.code`'s
SCREAMING_SNAKE_CASE convention for consistency even though `skipReason` is a plain
String column (§5's asymmetry), not JSON. If Prompt 2 discovers it needs finer
granularity, the instruction left in the source comment is to *extend* this union rather
than write free text beside it — a mix of pinned and ad-hoc reasons defeats pinning any
of it.

Also added `@@index([repositoryId, indexState])` — in `plan.md` §24.2's list, absent
from §6's own Prisma block. Same "declare it, it's cheap, the phase document already
specifies it elsewhere" reasoning `phase-02-log.md` §4 used for `Repository.htmlUrl` etc.
Prompt 2's "list skipped files" / reconciliation queries (§14 Database Verification) need
exactly this index.

Migration `20260824202937_repository_indexing` applied cleanly, non-interactively —
unlike `phase-01-log.md` §11's experience with `prisma migrate dev` needing the
diff+deploy workaround, this one is purely additive (two new tables, one new enum, no
column changes to existing tables), so nothing required confirmation. Inspected the
generated SQL directly: every index from §6 materialized, including the DESC sort on
`IndexJob_repositoryId_createdAt_idx`.

`db.test.ts` gained a `RepositoryFile + IndexJob (phase-03 §6)` describe block mirroring
the existing `Repository model + IndexStatus enum` one exactly — defaults, the
`(repositoryId, path)` uniqueness (the interrupted-job idempotency guarantee itself,
tested directly rather than assumed), cascade delete, the full column list, the indexes,
the `FileClassification` enum's full value set. `db-helpers.ts`'s `resetDatabase()`
TRUNCATE list gained `"IndexJob"` and `"RepositoryFile"`.

## 8. Sub-task 1.4 — tarball-fetcher: raw `fetch`, and the redirect-option finding corrected mid-session

The first draft of this module's header comment claimed `@octokit/request` "does not
expose a `redirect` option through to the underlying fetch call at all." That was
**wrong**, caught by actually reading the installed source before shipping the claim
(§1 above) rather than after: `requestOptions.request.redirect` *is* forwarded, and a
`parseSuccessResponseBody: false` option *does* exist to get the raw stream instead of a
buffered body. Both problems this module needs to avoid (buffering, no redirect control)
have an Octokit-native fix.

What doesn't have one: `createAuthPlugin` (octokit-factory.ts) attaches the installation
bearer token to *every* request made through that Octokit instance, unconditionally —
including a full-URL request to `codeload.github.com`. That URL is already
self-authenticating (a signed, credentialed query string is the entire point of the
redirect); sending an *additional* `Authorization: token …` header to it would widen the
credential surface for no reason, and there is no per-request way to suppress one
plugin's hook without constructing a second, differently-configured Octokit — its own
complication for a two-call, one-shot fetch. That is the actual, verified reason this
module is a raw `fetch`, not the reason originally (incorrectly) written down. The
corrected reasoning is what shipped in the final file; recorded here so the wrong claim
doesn't quietly persist as institutional memory the way `phase-02-log.md` §32 warns a
stale fixture value can.

**Retry ownership is a new distinction this module introduces, not carried over from
`app-auth.ts`.** `app-auth.ts`'s `mint()` retries 5xx/network failures 3× internally
because it runs inside a request/response HTTP handler with no outer retry mechanism.
`fetchTarballStream` is called from an Inngest step (Prompt 2), which already retries the
whole step on a thrown error (`repository-index`'s own `retries: 3`, plan.md §27.2).
Retrying inside *and* outside would multiply attempts up to 3×3 against a phase document
that states the budget as exactly 3. So a 5xx or network failure here is **one attempt**
that throws a plain `Error`, letting the caller's mechanism own the backoff — 401 / 403
(with or without rate-limit headers) reuse `GithubAccessRevokedError` /
`GithubRateLimitError` by throwing them directly (the same two classes app-auth.ts
throws for the identical underlying conditions, so a Prompt 2 `catch` block written once
catches both call sites); 404 is a result variant (`{ok:false, reason:
"REPO_NOT_FOUND"}`), since there is no existing thrown-error equivalent to reuse for it
and `github-result.ts`'s own pattern is exactly "a discriminated result, not always an
exception."

Logging: every request (both hops) emits the **same shape** octokit-factory.ts's
`createLoggingPlugin` does (`component: "github.client"`, `endpoint`, `status`,
`github.rate_limit_remaining`) — deliberately, so Prompt 3's "exactly two GitHub API
calls per full index run" assertion (§15) can count matching log lines regardless of
whether the call went through Octokit or this module's own raw fetch. The codeload hop
logs the **host only**, never the URL (which carries a signed, credentialed query
string) — verified with a dedicated test asserting the signed token value and the
minted installation token never appear in any captured log field, only the literal
string `"codeload.github.com"`.

13 unit tests, all against an injected `fetchImpl`/`getToken` (no network, no real
Octokit) — the happy path (follows the pinned redirect, streams correctly, exactly two
calls), the pinned-host rejection (a plain malicious host, and a look-alike
`codeload.github.com.evil.com`), a missing `Location` header, a forced second-hop
redirect (proving `redirect: "error"` is actually wired, not just requested), 404/500/
network-failure/401/403-with-headers/403-without-headers classification, and token-mint
error propagation.

## 9. Sub-task 1.5 — archive-extractor: library choice, argued against the alternatives actually read

`tar-stream` was chosen over `tar-fs` and `tar` (node-tar) specifically because it
performs **zero filesystem writes on its own** (confirmed by reading its full source, not
inferred from its README) — every `fs` call in `archive-extractor.ts` is this module's
own, over a path this module validated, never a dependency's internal path-joining taken
on faith. `tar-fs` and `tar` both extract *to disk themselves* with their own
(real, but unaudited-by-us) safety logic; the prompt's own instruction that "a library's
own safe-extract flag is not evidence" is exactly the reasoning that ruled them out —
not that they are unsafe, but that trusting them would mean not actually knowing.
`node:zlib`'s built-in `createGunzip()` (no `gunzip-maybe`) is used for decompression,
since the content type (gzip) is already known from the endpoint contract — no
auto-detection needed, and one fewer dependency.

## 10. Sub-task 1.5 — symlinks skip-and-continue, traversal aborts-and-cleans-up, and the bug the test suite caught

Two different attack shapes get two different responses, argued explicitly:

- **Path traversal and absolute/drive-letter paths abort the whole archive**
  (`UnsafeArchiveError`, §12's `UNSAFE_ARCHIVE`). `git archive` (what produces GitHub's
  tarball) never legitimately emits either — encountering one is proof of tampering, and
  continuing to trust the *rest* of an archive that already lied about one entry's path
  is not a risk worth taking for something running unattended in the background.
- **Symlinks and hardlinks are skipped and recorded, extraction continues.** Real
  repositories do contain symlinks (§13's own risk note); aborting on every one would
  fail legitimate repositories. Because the symlink is never *created* on disk, the
  classic follow-on attack (a symlink named `foo` pointing outside the root, then a
  later `foo/passwd` entry the OS resolves *through* the symlink on write) cannot occur
  here at all — `fs.mkdir(..., {recursive:true})` for `foo/passwd` just creates `foo` as
  an ordinary directory, because `foo` never existed as anything else. This is a
  structural argument, not a "we tested this one case" argument — verified anyway, by a
  test asserting the symlink path never appears anywhere under the extraction root.

**The security test suite caught a real bug before this shipped, not after.** The first
implementation's filename-hygiene check (`isValidPathSegment`) rejected `.`/`..`
segments as an ordinary invalid filename (skip-and-continue). Since it ran *before* the
path-escape check (`resolveSafePath`), an entry named `.../../../etc/passwd` was silently
**skipped as an invalid filename** rather than aborting the archive — the wrong failure
mode entirely, caught by `expect(...).rejects.toBeInstanceOf(UnsafeArchiveError)`
resolving `undefined` instead. Fixed by giving path-traversal detection exactly one
owner: `resolveSafePath`'s `path.relative()`-based check, which correctly handles the
"sibling prefix" defeat (`/tmp/job1` vs `/tmp/job10` — a raw `startsWith` check is fooled
by this; `path.relative` is not, verified by a direct unit test of the function itself)
as well as ordinary traversal. `isValidPathSegment` was narrowed to hygiene concerns only
(control characters, Windows-reserved names) that have nothing to do with escaping the
root. A second, distinct bug (also self-caught): an entry literally named `/etc/passwd`
would have had its leading `/` misread by `stripTopLevelComponent` as the top-level-
directory boundary, silently producing the seemingly-safe relative path `etc/passwd` —
fixed by checking `path.isAbsolute()`/drive-letter patterns against the **raw** entry
name before any top-level stripping happens.

**Filename policy**: allows any non-ASCII Unicode (verified with Japanese, French-accented,
and Cyrillic filenames in a test — §13's own `^[\w\-./ ]+$` regex is ASCII-only and would
have rejected all three) — rejects only NUL/control characters and Windows-reserved
names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`, with or without an extension),
each rejection recorded with `INVALID_FILENAME` rather than silent.

**The byte cap is a counting `Transform` between `gunzip` and the tar parser**, not a
per-entry or post-hoc check — it counts bytes for every entry whether ultimately written
or skipped (decompressing and parsing costs CPU/memory either way), and catches the cap
being exceeded *during* streaming. Proven with a 5 MB highly-compressible payload that
compresses to under 100 KB on the wire but is capped by a 1000-byte `maxTotalBytes` —
the test would pass trivially if the check ran against the compressed size or a fully-
buffered total; it doesn't, because the check has no way to see either of those
quantities, only the running decompressed total. A separate per-entry sanity cap (an
entry's *declared* `header.size` alone exceeding the total budget) rejects before a
single byte of that entry is read.

**Cleanup contract**: `extractRepositoryArchive(stream, options, onExtracted)` takes a
callback rather than returning a path, specifically so the `finally` that removes the
per-job temp directory can wrap the callback too — cleanup runs on every path out
(extraction failure, callback throw, callback success) without relying on the caller to
remember. Verified directly: a test that lets `onExtracted` throw after a *successful*
extraction still finds the temp directory gone afterward.

24 tests total, all built from crafted fixtures assembled with `tar-stream`'s own
`pack()` (never a real malicious file on disk) — traversal, absolute paths, symlink/
hardlink skip-and-continue (including one that proves a legitimate sibling entry still
extracts), both caps, a truncated gzip stream, a non-gzip stream, filename hygiene
(non-ASCII acceptance, control-character/Windows-reserved rejection, the regression
test above), an unsupported entry type (fifo), and the legitimate-archive correctness
path (top-level stripping, exact file/byte counts).

## 11. Sub-task 1.7 — the packages-buildability discovery, and why it belongs to this prompt

While building `Dockerfile.worker`, `node dist/server.js` (the actual compiled output
`pnpm build` produces) failed immediately: `Cannot find module
'.../packages/observability/src/logger.js' imported from
'.../packages/observability/src/index.ts'`. Traced to the root cause: `@repo/db`,
`@repo/github`, `@repo/observability`, and `@repo/shared` all shipped `"exports": {".":
"./src/index.ts"}` — raw TypeScript source. `tsc`, `tsx`, and `vitest` all resolve this
correctly (they understand TypeScript's "write `.js`, mean `.ts`" `NodeNext` convention);
plain `node` running compiled JS does not — it can natively execute a *single* `.ts`
entry file (Node 22's type-stripping), but does not apply TypeScript's own module-
resolution algorithm to that file's *own* imports, so a `.js`-suffixed specifier that
actually means `.ts` fails to resolve.

**This was already broken for `apps/api`, not something this phase introduced** —
verified directly: `apps/api`'s own `node dist/server.js` fails identically, and has
been broken since `packages/shared` was introduced in Phase 01. It was never caught
because no previous phase's verification ever ran a *compiled* build with plain `node` —
every "boot the server" check used `tsx watch` (a TypeScript-aware dev runner) or
vitest. `Dockerfile.worker` is the first thing in this repository that actually needs
`node dist/server.js` to work, which is exactly why it is the first thing that found
this.

**Fixed at the root**, not worked around in the Dockerfile: each of the four packages
gained a `tsconfig.json` (matching `apps/worker`'s own shape, plus `"declaration":
true`) and a real `"build": "tsc"` script, with `package.json`'s `"exports"` switched to
`{"types": "./dist/index.d.ts", "default": "./dist/index.js"}`. This is not a novel
pattern — it is how every *external* npm dependency in this monorepo already works
(compiled `dist/` + `.d.ts`, resolved through `node_modules`); the previous
source-only shape was the unusual choice, and the one that didn't support a real
production build.

`dist/` is **gitignored, not committed** — unlike `packages/db/src/generated` (Prisma's
own generated *source*, committed so a consumer can read/typecheck against it without
running `prisma generate` first). This is hand-written TypeScript's *compiled output*,
a fundamentally different artifact that should be rebuilt, not committed and allowed to
drift. The consequence: `pnpm typecheck` and `pnpm test:unit`, run from a genuinely
fresh clone (no `dist/` anywhere), would otherwise fail identically to the
`node dist/server.js` failure above, since apps/api/worker's own `tsc`/vitest now need
`@repo/observability`'s compiled `.d.ts`/`.js` to exist. **Verified by actually deleting
every `dist/` directory and re-running the full suite from that state** — it failed
first (dozens of `Cannot find module '@repo/db'`-shaped errors), then passed after
adding `"dependsOn": ["^build", "^typecheck"]` to `turbo.json`'s `typecheck` task and
`"dependsOn": ["^build"]` to `test:unit`/`test:integration`. `lint` needed no change —
confirmed separately, since this repo's ESLint config does not use type-aware linting
and never needed `dist/` to exist. Turbo's own caching means this costs real time only
after an actual source change to one of the four packages, not on every invocation —
verified by running the full suite twice from a clean `dist/`-deleted state and
observing the second run come back from cache.

**Two small, contained fixes were needed inside `packages/db` itself**, both because
type-checking against *compiled* `.d.ts` output is measurably less forgiving than
type-checking against source directly (a well-known friction point with Prisma's
complex generic/conditional return types specifically):
- `project.repository.ts`'s `findSlugsForUserByPrefix` had an inferred-`any` parameter
  once its `prisma.project.findMany({select:...})` return type was read through a
  round-tripped `.d.ts` rather than Prisma's own source — fixed with an explicit local
  type annotation, not by touching Prisma's types.
- `auth-adapter.ts`'s `authAdapter` needed an explicit `Adapter` type annotation (from
  `@auth/core/adapters`, added as an explicit dependency rather than relying on
  hoisting) for the same reason — TypeScript's own error was explicit about this:
  "cannot be named without a reference to `Adapter` ... likely not portable," a real
  declaration-emit limitation, not a bug in this code.
- Four extension-less relative imports (`packages/db/src/{index,client,auth-adapter}.ts`)
  had always relied on `packages/db` having no `"type": "module"` field, which made
  TypeScript treat it as CommonJS for module-detection purposes and therefore not
  require extensions. Adding `"type": "module"` (to match every other package in this
  workspace, and because Node needs a real ESM package to execute the compiled output
  correctly) surfaced these as real `NodeNext` errors; fixed by adding the `.js`
  suffixes the rest of the codebase already uses everywhere else.

## 12. Sub-task 1.7 — Prisma's own generated code had the identical extension bug, fixed at the generator level

Beyond `packages/db`'s own hand-written files, the *generated* client itself
(`packages/db/src/generated/client.ts`) has an internal `import * as $Class from
"./internal/class"` with no extension — Prisma's own code, carrying `// @ts-nocheck`,
which is precisely why the missing extension never surfaced as a type error (the file is
never type-checked) and only appeared as `ERR_MODULE_NOT_FOUND` once compiled and
actually run. This could not be hand-edited (regenerated on every `prisma generate`).
Fixed at the source: `schema.prisma`'s `generator client` block gained
`moduleFormat = "esm"` and `importFileExtension = "js"`. Found by grepping the installed
`prisma` CLI's own bundled source for these exact option names (they are not documented
in any reference this environment could reach), confirmed by regenerating and checking
the emitted import gained its `.js` suffix. `pnpm db:generate` was re-run and the
regenerated client committed (matching the established "generated Prisma source is
committed" convention — the generator *config* changed, so the generated output
legitimately changes with it, same as any schema-driven regeneration).

## 13. Sub-task 1.7 — Dockerfile.worker: `turbo prune`, verified live under hardening

Multi-stage build via `turbo prune worker --docker` (§1) — a pruner stage computes
exactly the workspace subset needed, a `deps` stage installs from the pruned lockfile
(cache-friendly: invalidates only on `package.json`/lockfile changes), a `builder` stage
overlays real source and compiles, a `prod-deps` stage does a *second*, `--prod` install
(so the runtime image excludes `typescript`/`vitest`/`tsx`/`@types/*`), and the final
`runner` stage copies only compiled output + prod `node_modules`.

**`turbo prune`'s output does not include the workspace-root `tsconfig.json`**, even
though every pruned package's own `tsconfig.json` extends it — verified by inspecting
`out/full/`'s contents directly (§1), and it surfaced as a real build failure
("File '../../tsconfig.json' not found") before being fixed with an explicit
`COPY tsconfig.json ./tsconfig.json` in the builder stage.

**`@prisma/engines`' postinstall warns loudly about missing `libssl`** even though this
project's driver-adapter setup (`@prisma/adapter-pg` + `pg`) never invokes a native
query engine binary at all (confirmed: no `.node`/ELF files exist anywhere under
`packages/db/src/generated`, §1) — the dependency is transitive, not something this
repo chose. Installing `openssl` in the builder stage (`apt-get install
--no-install-recommends openssl`) is cheap and turns a "may not work as expected"
warning into nothing, rather than trusting an unverified fallback.

**Hardening, verified live, not just written**: `docker build -f Dockerfile.worker .`
succeeds; `docker run --read-only --tmpfs /tmp/worker:rw,uid=1001,gid=1001 ...` boots
the container, the healthcheck reaches `healthy`, `GET /api/inngest` returns 200 with
`function_count: 1`, `docker exec ... id` confirms `uid=1001(worker)`, and a direct
`touch /app/probe` inside the running container fails with `Read-only file system` while
`touch /tmp/worker/probe` succeeds — the read-only-except-tmpfs boundary is real, not
asserted. Repeated through `docker compose --profile worker up -d --build worker`
(the actual local-dev path) with identical results. All test containers/images were
removed after verification; nothing was left running.

**Deploy target — Fly.io/Railway/ECS, never Vercel** (plan.md §1.3 change ③, restated
in `docs/deployment.md`'s new "Worker container" section): tarball extraction and
future parsing/embedding are minutes of CPU and hundreds of MB of disk, which
serverless execution limits and mostly-read-only filesystems make fragile regardless of
code quality. No hosting platform is provisioned from this environment (no credentials
available) — the container is verified to build and run correctly; it has never been
deployed anywhere real. See Outstanding below.

The `worker` service in `docker-compose.yml` is opt-in via a compose **profile**
(`docker compose --profile worker up`), not started by a plain `docker compose up` —
per §16's "verification must happen on the actual worker deployable, not a `tsx watch`
shortcut," while not taxing every contributor who only wants Postgres/Redis for
`pnpm dev`.

## 14. Where the phase document is wrong or under-specified

Continuing the numbering convention from `phase-02-log.md` §30/§44 (a fresh list per
phase, not a continued global count):

1. **§18's file list assumes the single-`src/`-tree layout `phase-00-log.md` §1
   already established this repository does not have.** Every path in §18
   (`src/app/api/...`, `src/indexing/...`, `src/inngest/...`) needed remapping onto
   `apps/api`/`apps/worker`/`packages/db` — this prompt's own instructions already
   carried the mapping table forward, so this is confirmation, not new information, but
   worth restating since it applies to every file this prompt touched.
2. **§16's "verified on the actual worker deployable in staging" is not satisfiable
   from any environment without real hosting credentials** — restating
   `phase-02-log.md` §44's finding #3 about the equivalent staging requirement, now
   true for this phase's own Definition of Done too. What *was* verified is the
   strongest available substitute: the real container, built and run with the real
   hardening flags, against real (locally running) Postgres and Redis.
3. **§19 says `INDEX_MAX_TOTAL_BYTES` and `INDEX_MAX_FILE_COUNT` have "a code default,"
   implying they are optional with no further comment on their per-entry
   implications** — but a per-entry sanity cap (no single archive entry may alone
   exceed the total byte budget) is not mentioned anywhere in §19 or §13, only implied
   by §13's general "consider a per-entry size sanity cap" phrasing for
   `archive-extractor.ts`. Implemented as "the same value as the total cap" rather than
   a separate configuration surface — simplest defensible choice, recorded rather than
   silently added.
4. **§6's Prisma block for `RepositoryFile` omits `@@index([repositoryId, indexState])`,
   which `plan.md` §24.2 lists** — the same class of discrepancy `phase-02-log.md` §4
   found repeatedly between the phase document and `plan.md` for `Repository`. Resolved
   the same way: added it, since Prompt 2's own database-verification needs (§14) will
   query by `indexState`.
5. **The GitHub-package-promotion decision (§1.1's "Option A") is presented as
   optional ("evaluate at least these options") but is functionally required** once the
   AsyncLocalStorage-sharing argument in §3 above is accounted for — Option B (a
   worker-local thin module) was never actually viable once the tracing-correlation
   consequence is traced through, not merely "less clean." Worth being explicit that
   this wasn't a close call dressed as a considered one.

## 15. Outstanding — requires human action

Carried forward from `phase-02-log.md` §43 (still open, unchanged by this prompt) plus
this prompt's own:

- [ ] **No real GitHub App has been registered.** Unchanged since Phase 02.
      `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` remain placeholders everywhere, including
      in `apps/worker/.env`.
- [ ] **No real installation exists, no repository has ever been connected against real
      GitHub.** Unchanged.
- [ ] **CI still does not run** — `.github/workflow/ci.yml` remains in a directory
      GitHub never reads. Nothing in this prompt has been verified by CI; every claim in
      this log is a local verification.
- [ ] **`pnpm format:check` still fails** (pre-existing `prettier.config.js`/`.prettierrc`
      conflict, `phase-02-log.md` §13/§43) — untouched, new files match their neighbors'
      ~100-column style.
- [ ] **No staging environment exists.**
- [ ] **New this prompt: no real hosting platform is provisioned for `apps/worker`.**
      `Dockerfile.worker` is verified to build and run correctly locally (§13), including
      under the exact hardening flags (`--read-only`, `--tmpfs`, non-root) a real
      deployment would use, but it has never run on Fly.io/Railway/ECS or any other real
      host. No credentials for any such platform are available from this environment.
- [ ] **New this prompt: the worker has never registered with Inngest Cloud** (only the
      local Dev Server, via `INNGEST_DEV=1`) — needs a real deployed origin first.
- [ ] **New this prompt: a real ~1,000-file repository has never been indexed
      end-to-end** — blocked on both a real GitHub App/installation (above) and Prompt
      2's `repository-index` function, which does not exist yet.

## 16. Commits in this prompt

| Commit | Sub-task |
|---|---|
| `9cbeca7` | 1.1 — promote the GitHub App client to `@repo/github`; extract `@repo/observability` |
| `e16dda7` | 1.2 — turn `apps/worker` into a real deployable (env schema, config, docs) |
| `ae2cf4d` | 1.3 — `RepositoryFile`, `IndexJob`, `FileClassification` Prisma models + migration |
| `889e380` | 1.4 — streamed tarball fetcher with redirect-host pinning |
| `d45750f` | 1.5 + 1.6 — path-traversal-safe archive extractor with its security test suite (shipped together — the tests are what proved the extractor correct, including catching a real bug; see phase-02-log.md §15's precedent for shipping boundary tests beside the code they verify) |
| `129cd4f` | 1.7 (part 1) — give `@repo/db`/`@repo/github`/`@repo/observability`/`@repo/shared` real production builds (the discovery in §11/§12, prerequisite for the Dockerfile) |
| `12a2e29` | 1.7 (part 2) — `Dockerfile.worker`, `.dockerignore`, `docker-compose.yml` wiring, deployment docs |

**One commit not made by this session's own `git commit` calls**: `1998724`
(`feat(github): add various repository fixtures for testing`) sits between `main` and
`9cbeca7` in this branch's history, dated during sub-task 1.1's work, authored under this
session's git identity. This is the same environment behavior `phase-01-log.md` §27
already documented and named ("something in this environment committed each change as
it was made... no git commit was run as part of this work") — an automatic mid-flight
checkpoint of work in progress, superseded by this session's own deliberate `9cbeca7`
commit immediately after. Its diff is a subset of `9cbeca7`'s (the github-tree move and
the observability extraction, mid-way through). Flagged per that same entry's
precedent — not fixed by rewriting history, since the final tree state is correct and
unaffected.

## 17. What Prompt 2 inherits

**The worker is a real, verified deployable.** `apps/worker` has `@repo/db`,
`@repo/github`, and `@repo/observability` as real dependencies; boots against real
Postgres/Redis; fails fast naming every missing/invalid env var; and `Dockerfile.worker`
builds and runs correctly under full hardening (§13). `apps/worker/src/inngest/
functions/noop.ts` is still the only registered Inngest function — **its deletion is
Prompt 2's job**, exactly as `phase-02-log.md` §21 already deferred it, now for the same
reason stated a third time: `repository-index` is what proves the worker is discoverable
better than the noop ever could.

**`fetchTarballStream(installationId, owner, repo, sha, options?)`**
(`apps/worker/src/indexing/fetcher/tarball-fetcher.ts`) — given an *already-resolved*
SHA (this module does not resolve branches/commits; that's step 2 of `repository-index`,
using `GET /repos/{o}/{r}` — already available as `repositoryGithub.getRepository` — and
`GET /repos/{o}/{r}/commits/{branch}`, which **does not exist yet** as a wrapper in
`@repo/github` and Prompt 2 will need to add), returns
`Promise<{ok:true, stream: ReadableStream<Uint8Array>} | {ok:false, reason:
"REPO_NOT_FOUND"} | {ok:false, reason:"UNSAFE_REDIRECT", host:string}>`, or throws
`GithubAccessRevokedError`/`GithubRateLimitError` (both from `@repo/github`, reused —
`GithubRateLimitError.details.retryAfterSeconds` is what `step.sleepUntil` should key
off) or a plain `Error` for anything the caller's own retry should handle (5xx, network
failure). Never buffers; the returned stream is exactly what's needed to hand to
`extractRepositoryArchive`.

**`extractRepositoryArchive(gzippedStream, options, onExtracted)`**
(`apps/worker/src/indexing/fetcher/archive-extractor.ts`) — `options` needs
`tempRootDir` (resolve `env.WORKER_TEMP_DIR` or a container-standard default before
calling), `jobId` (use the `IndexJob.id`), `maxTotalBytes`/`maxFileCount` (from
`env.INDEX_MAX_TOTAL_BYTES`/`env.INDEX_MAX_FILE_COUNT`). `onExtracted(rootDir, summary)`
is where Prompt 2's walk/filter/hash/persist steps belong — `rootDir` is
repository-relative already (top-level directory stripped), and everything under it is
safe to read without further path validation, since every entry that reached disk
already passed `resolveSafePath`. **The temp directory is gone the instant
`extractRepositoryArchive`'s returned promise settles, on every path** — do not return a
bare path out of `onExtracted` and try to read it afterward; do all the reading inside
the callback. `summary.skipped` (an `ExtractionSkip[]`, `{rawPath, reason}`) covers
*extraction-level* rejections (`SYMLINK`/`HARDLINK`/`UNSUPPORTED_ENTRY_TYPE`/
`INVALID_FILENAME`/`NO_TOP_LEVEL_PREFIX`) — a **different, non-overlapping** vocabulary
from `@repo/shared`'s `SkipReason` (`SKIPPED_TOO_LARGE` etc.), which describes Prompt
2's own filter pipeline declining to *index* a file that the extractor already
successfully wrote to disk. Throws `UnsafeArchiveError`/`ArchiveTooLargeError` (both
exported, both carry `.code` — `"UNSAFE_ARCHIVE"`/`"REPO_TOO_LARGE"`, matching
`@repo/shared`'s `IndexErrorCode` exactly) for the whole-archive-aborting cases; Prompt
2's Inngest step is where these should become `indexError.code` and (for
`UnsafeArchiveError`) a `NonRetriableError`.

**Type vocabulary is in `@repo/shared`, not duplicated**: `IndexState`, `SkipReason`,
`ParseState` (literally `"OK"` — Phase 04's problem to widen), `IndexJobStatus`,
`IndexJobMode`, `IndexErrorCode`, all with their `_STATES`/`_REASONS`/`_CODES` const
arrays and (for `IndexState`) an `isIndexState` guard, matching the `isConnectionStatus`
precedent. `IndexErrorCode` currently covers exactly the four codes this prompt's own
modules can produce (`REPO_NOT_FOUND`, `TARBALL_DOWNLOAD_FAILED`, `UNSAFE_ARCHIVE`,
`REPO_TOO_LARGE`) — Prompt 2 will need to decide whether `repository-index`'s own
lock-acquisition/no-op/generic-failure paths need additional codes, and should extend
this same union rather than starting a second one.

**Everything needed to persist a `RepositoryFile` row is now in the schema** (§6/§7
above) — `commitSha`, `contentHash`, `sizeBytes` are required (not defaulted) columns,
so Prompt 2's hashing step (sha256 of content, per §8.2 step 5) must run before any
insert, not after. `packages/db`'s Prisma client is now built the same way every other
consumer is (§11) — no special-casing needed for how Prompt 2 imports `@repo/db`.

**`Repository.indexedCommitSha`/`indexVersion`/`indexedFileCount`/`skippedFileCount`/
`lastIndexedAt`/`indexError` are all still exactly as Phase 02 left them** (unpopulated,
per `phase-02-log.md` §42) — this prompt did not touch `repository.repository.ts` or
`repository.service.ts` beyond the import-path mechanics in §2, and did not implement
any of the lock-acquisition (`UPDATE ... WHERE indexStatus IN (...)`), SHA-resolution,
or terminal-state-transition logic §8/§11 describe. That is entirely Prompt 2's function
to write.

**apps/api's production build now works too** (§11), a side effect of fixing this for
the worker — not this phase's job to *deploy*, but worth knowing it is no longer
secretly broken if a later phase needs it.
