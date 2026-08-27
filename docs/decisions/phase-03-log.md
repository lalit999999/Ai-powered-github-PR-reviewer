# Phase 03 — Prompt 1 Decision Log

Records the judgment calls made implementing **Prompt 1** of Phase 03 (foundation, worker
deployable, tarball fetcher, archive extractor). Same convention as
`phase-00-log.md`/`phase-01-log.md`/`phase-02-log.md`: this file records what was decided
_and_ what could not be verified from this environment. Prompt 2 and Prompt 3 build on
this; entries here are binding for that work.

## 0. Inherited baseline (verified before writing any Phase 03 code)

Every command run against the tree as inherited from `main` (`d3e97f7`, the merge of
`phase-02-git-repo-integration`), before a single line was changed:

| Command                 | Result                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm install`          | Clean — "Already up to date", 6 workspace projects                                                           |
| `pnpm db:generate`      | Prisma Client 7.9.1 generated to `packages/db/src/generated`                                                 |
| `pnpm lint`             | Pass, 0 errors (`turbo lint` + the root boundary/no-console config)                                          |
| `pnpm typecheck`        | Pass — 3 tasks (`api`, `web`, `worker`)                                                                      |
| `pnpm test:unit`        | Pass — **20 files, 377 tests**                                                                               |
| `pnpm test:integration` | Pass — **7 files, 99 tests** (Testcontainers Postgres; Docker was available in this environment — see below) |
| `pnpm build`            | Pass — 3 tasks                                                                                               |
| `prisma migrate status` | "Database schema is up to date!", 3 migrations found                                                         |

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

| Package                | Version                                       | What was verified, and where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@octokit/request`     | 10.0.15                                       | `fetch-wrapper.js`: `requestOptions.request.redirect` **is** forwarded to the underlying `fetch` (an initial assumption that it wasn't wrong — see §8); a 3xx response resolves normally (not thrown) with no special-casing; the default response-body path calls `response.arrayBuffer()` for a non-JSON/`text/*` content type unless `request.parseSuccessResponseBody: false` is set.                                                                                                                                                                                                                                                                                                     |
| `tar-stream`           | 3.2.0                                         | `extract.js`: `Extract` is simultaneously a `Writable` and an async-iterable; each `entry` event/iteration yields `(header, stream, callback)` with **no filesystem interaction anywhere in the package** — confirmed by reading the full source, not just the README. `header.type` is one of `file                                                                                                                                                                                                                                                                                                                                                                                          | link | symlink | directory | block-device | character-device | fifo | contiguous-file | pax-*`(per`@types/tar-stream@3.1.4`, which the package itself does not ship). |
| `tar-fs`               | 2.1.5, 3.1.3 (transitive, via Testcontainers) | Read enough of its README/exports to confirm it extracts _to the filesystem itself_ (its whole purpose) — considered and rejected; see §9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tar` (node-tar)       | 7.5.22 (transitive)                           | Same treatment — a complete extractor with its own internal path-safety logic, considered and rejected for the same "no seam to inspect before it acts" reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Node.js                | 22.23.1                                       | `fetch(url, { redirect: "manual" })` resolves with the 3xx response and a readable `Location` header (`type: "basic"`, not the browser's opaque-redirect behavior) — verified empirically against a local HTTP server, not assumed from the fetch spec. `fetch(url, { redirect: "error" })` on an actual redirect rejects with `TypeError: fetch failed`, also verified empirically. `Readable.fromWeb()` exists and works; its TypeScript signature is declared against `node:stream/web`'s `ReadableStream`, a nominally distinct type from the DOM-lib global of the same name that `fetch()` and this phase's own code use, requiring a cast (see `archive-extractor.ts`).                |
| `turbo`                | 2.10.11                                       | `turbo prune <scope> --docker` — ran it directly against this repo (`turbo prune worker --docker`) and inspected the output: `out/json/` (pruned `package.json`s + lockfile) and `out/full/` (pruned real source), scoped to exactly `@repo/db`, `@repo/github`, `@repo/observability`, `@repo/shared`, `worker` for the `worker` scope — nothing from `apps/api`/`apps/web` included. Does **not** carry along the workspace-root `tsconfig.json` even though every pruned package's own `tsconfig.json` extends it — verified by inspecting `out/full/`'s contents directly, not assumed.                                                                                                   |
| Prisma                 | 7.9.1                                         | The `prisma-client` generator's `moduleFormat`/`importFileExtension` options exist and are accepted (found by grepping the installed `prisma` CLI's own minified `build/cli.js` for the option names propagating through its internal generator pipeline, then confirmed empirically by setting them and re-running `prisma generate`) — see §12. The generated client's own internal relative imports (e.g. `./internal/class`) ship **without** an extension by default and carry `// @ts-nocheck`, which is why the missing extension never surfaced as a _type_ error, only as a runtime `ERR_MODULE_NOT_FOUND` once the client was actually compiled and run rather than read as source. |
| `@auth/prisma-adapter` | 2.11.3                                        | `index.d.ts`: `PrismaAdapter()` imports `Adapter` from `@auth/core/adapters` internally but does not re-export it — confirmed by reading the shipped `.d.ts` directly, which is why `packages/db/src/auth-adapter.ts` needed its own explicit `@auth/core` dependency once it started emitting its own declaration files (see §12).                                                                                                                                                                                                                                                                                                                                                           |

## 2. Sub-task 1.1 — promoting the GitHub client: the options actually weighed

The phase document's own framing (echoed in this prompt) named three options. Recorded
here with the reasoning that decided between them, since this is the largest
architectural call in the prompt.

**Option C (apps/worker depends on apps/api as a workspace package) was rejected
immediately** — it would drag Express, Auth.js, and every apps/api-only concern into the
worker's build for no benefit, and directly contradicts §1's entire premise that the
worker is a _separate_ deployable.

**Option B (a worker-local thin GitHub module) was rejected** — it would either
duplicate token minting/the ETag/throttle/retry stack (a second copy of exactly the logic
`phase-02-log.md` §12 spent real effort getting right: the 401-vs-403-with-headers
disambiguation, the 50-minute cache TTL reasoning, the retry taxonomy) or construct a
second Octokit, which `phase-02-log.md` §16 forbids by name ("Reuse it; do not construct
a second Octokit anywhere"). Neither is "contained" duplication — token-mint retry logic
is exactly the kind of thing that silently drifts between two copies.

**Option A (promote to `packages/github`) was chosen**, and the prompt's own framing —
that this requires _also_ promoting the shared observability primitives rather than
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
`**/github/services/*`) existed specifically to catch a _relative_ import bypassing the
package-name check, because Phase 02 put the client inside `apps/api` where no
package-name pattern could see it (`phase-02-log.md` §10). Once the client is a real
package, that specific hole is closed by the _first_ pattern group (`@repo/github`
already listed there since Phase 00's forward declaration) — but a route could still
reach _past_ `@repo/github`'s public `index.ts` into its internals via a long relative
path. Added `**/packages/github/src/**` to the same pattern group for that narrower case,
and rewrote `rule-a-github-tree-violation.ts` to demonstrate exactly that (a deep
relative import into `packages/github/src/client/octokit-factory.js`) rather than the
now-nonexistent `apps/api/src/github/**` path. `boundaries.test.ts` still fails on it —
confirmed by running the suite, not just by inspection of the pattern.

## 3. Sub-task 1.1 — the observability consolidation is a correctness requirement, not tidiness

`apps/worker`'s `lib/{logger,tracing}.ts` were a deliberate, time-boxed duplicate of
`apps/api`'s own copies (`phase-01-log.md` §9) — and had already drifted: the worker's
copy was missing the Phase 02 redaction rules (`token`/`accessToken`/`privateKey`-shaped
keys), which matters specifically _now_, the first phase where the worker mints and
holds a GitHub installation token.

But the reason this had to be fixed **before**, not alongside, the GitHub client's move
is sharper than redaction-rule drift: `tracing.ts`'s `AsyncLocalStorage` instance is a
**module-level singleton**. If `packages/github` had its own copy of `tracing.ts` (a
third copy, as a worker-local fix would have produced), then `getTraceContext()` called
from inside the GitHub client would read from a _different_ `AsyncLocalStorage` instance
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
`accessToken: "ghs_installationtoken"` → `[REDACTED]` — now runs against the _one_ logger
both deployables use, so sub-task 1.2's "port the redaction rules and add a test"
requirement was satisfied by construction, not by writing a second test. Recorded as
"nothing further needed" in that sub-task's commit rather than silently skipped.

### The mocking fallout, and why `importOriginal` matters here specifically

Several existing unit/integration tests did `vi.mock("../../lib/logger.js", () => ({
createLogger: () => logSpies }))` — a **narrow** mock returning only `createLogger`. Once
logger and tracing became the same module (`@repo/observability`), a narrow mock like
that silently nulls out every _other_ export from that module for the whole test file's
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
`prisma` singleton — unmocked. This had never failed before because _some other_ test
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
class _name_ `apps/api/src/lib/errors.ts` already uses for an unrelated, HTTP-envelope-
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
ever reach the _default_, config-reading code paths this seam replaced. No test needed to
change to accommodate this.

`apps/worker/src/lib/config.ts` gained `DATABASE_URL` (required — Rule B confines
_queries_ to `*.repository.ts` files, but `packages/db/src/client.ts` reads
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
filter pipeline needs something to assign _from_, and a downstream phase branching on
`skipReason` needs it machine-comparable. Every value follows `indexError.code`'s
SCREAMING_SNAKE_CASE convention for consistency even though `skipReason` is a plain
String column (§5's asymmetry), not JSON. If Prompt 2 discovers it needs finer
granularity, the instruction left in the source comment is to _extend_ this union rather
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
(§1 above) rather than after: `requestOptions.request.redirect` _is_ forwarded, and a
`parseSuccessResponseBody: false` option _does_ exist to get the raw stream instead of a
buffered body. Both problems this module needs to avoid (buffering, no redirect control)
have an Octokit-native fix.

What doesn't have one: `createAuthPlugin` (octokit-factory.ts) attaches the installation
bearer token to _every_ request made through that Octokit instance, unconditionally —
including a full-URL request to `codeload.github.com`. That URL is already
self-authenticating (a signed, credentialed query string is the entire point of the
redirect); sending an _additional_ `Authorization: token …` header to it would widen the
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
Retrying inside _and_ outside would multiply attempts up to 3×3 against a phase document
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
on faith. `tar-fs` and `tar` both extract _to disk themselves_ with their own
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
  continuing to trust the _rest_ of an archive that already lied about one entry's path
  is not a risk worth taking for something running unattended in the background.
- **Symlinks and hardlinks are skipped and recorded, extraction continues.** Real
  repositories do contain symlinks (§13's own risk note); aborting on every one would
  fail legitimate repositories. Because the symlink is never _created_ on disk, the
  classic follow-on attack (a symlink named `foo` pointing outside the root, then a
  later `foo/passwd` entry the OS resolves _through_ the symlink on write) cannot occur
  here at all — `fs.mkdir(..., {recursive:true})` for `foo/passwd` just creates `foo` as
  an ordinary directory, because `foo` never existed as anything else. This is a
  structural argument, not a "we tested this one case" argument — verified anyway, by a
  test asserting the symlink path never appears anywhere under the extraction root.

**The security test suite caught a real bug before this shipped, not after.** The first
implementation's filename-hygiene check (`isValidPathSegment`) rejected `.`/`..`
segments as an ordinary invalid filename (skip-and-continue). Since it ran _before_ the
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
being exceeded _during_ streaming. Proven with a 5 MB highly-compressible payload that
compresses to under 100 KB on the wire but is capped by a 1000-byte `maxTotalBytes` —
the test would pass trivially if the check ran against the compressed size or a fully-
buffered total; it doesn't, because the check has no way to see either of those
quantities, only the running decompressed total. A separate per-entry sanity cap (an
entry's _declared_ `header.size` alone exceeding the total budget) rejects before a
single byte of that entry is read.

**Cleanup contract**: `extractRepositoryArchive(stream, options, onExtracted)` takes a
callback rather than returning a path, specifically so the `finally` that removes the
per-job temp directory can wrap the callback too — cleanup runs on every path out
(extraction failure, callback throw, callback success) without relying on the caller to
remember. Verified directly: a test that lets `onExtracted` throw after a _successful_
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
plain `node` running compiled JS does not — it can natively execute a _single_ `.ts`
entry file (Node 22's type-stripping), but does not apply TypeScript's own module-
resolution algorithm to that file's _own_ imports, so a `.js`-suffixed specifier that
actually means `.ts` fails to resolve.

**This was already broken for `apps/api`, not something this phase introduced** —
verified directly: `apps/api`'s own `node dist/server.js` fails identically, and has
been broken since `packages/shared` was introduced in Phase 01. It was never caught
because no previous phase's verification ever ran a _compiled_ build with plain `node` —
every "boot the server" check used `tsx watch` (a TypeScript-aware dev runner) or
vitest. `Dockerfile.worker` is the first thing in this repository that actually needs
`node dist/server.js` to work, which is exactly why it is the first thing that found
this.

**Fixed at the root**, not worked around in the Dockerfile: each of the four packages
gained a `tsconfig.json` (matching `apps/worker`'s own shape, plus `"declaration":
true`) and a real `"build": "tsc"` script, with `package.json`'s `"exports"` switched to
`{"types": "./dist/index.d.ts", "default": "./dist/index.js"}`. This is not a novel
pattern — it is how every _external_ npm dependency in this monorepo already works
(compiled `dist/` + `.d.ts`, resolved through `node_modules`); the previous
source-only shape was the unusual choice, and the one that didn't support a real
production build.

`dist/` is **gitignored, not committed** — unlike `packages/db/src/generated` (Prisma's
own generated _source_, committed so a consumer can read/typecheck against it without
running `prisma generate` first). This is hand-written TypeScript's _compiled output_,
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
type-checking against _compiled_ `.d.ts` output is measurably less forgiving than
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

Beyond `packages/db`'s own hand-written files, the _generated_ client itself
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
committed" convention — the generator _config_ changed, so the generated output
legitimately changes with it, same as any schema-driven regeneration).

## 13. Sub-task 1.7 — Dockerfile.worker: `turbo prune`, verified live under hardening

Multi-stage build via `turbo prune worker --docker` (§1) — a pruner stage computes
exactly the workspace subset needed, a `deps` stage installs from the pruned lockfile
(cache-friendly: invalidates only on `package.json`/lockfile changes), a `builder` stage
overlays real source and compiles, a `prod-deps` stage does a _second_, `--prod` install
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
   true for this phase's own Definition of Done too. What _was_ verified is the
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

| Commit    | Sub-task                                                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `9cbeca7` | 1.1 — promote the GitHub App client to `@repo/github`; extract `@repo/observability`                                                                                                                                                                                            |
| `e16dda7` | 1.2 — turn `apps/worker` into a real deployable (env schema, config, docs)                                                                                                                                                                                                      |
| `ae2cf4d` | 1.3 — `RepositoryFile`, `IndexJob`, `FileClassification` Prisma models + migration                                                                                                                                                                                              |
| `889e380` | 1.4 — streamed tarball fetcher with redirect-host pinning                                                                                                                                                                                                                       |
| `d45750f` | 1.5 + 1.6 — path-traversal-safe archive extractor with its security test suite (shipped together — the tests are what proved the extractor correct, including catching a real bug; see phase-02-log.md §15's precedent for shipping boundary tests beside the code they verify) |
| `129cd4f` | 1.7 (part 1) — give `@repo/db`/`@repo/github`/`@repo/observability`/`@repo/shared` real production builds (the discovery in §11/§12, prerequisite for the Dockerfile)                                                                                                           |
| `12a2e29` | 1.7 (part 2) — `Dockerfile.worker`, `.dockerignore`, `docker-compose.yml` wiring, deployment docs                                                                                                                                                                               |

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
(`apps/worker/src/indexing/fetcher/tarball-fetcher.ts`) — given an _already-resolved_
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
_extraction-level_ rejections (`SYMLINK`/`HARDLINK`/`UNSUPPORTED_ENTRY_TYPE`/
`INVALID_FILENAME`/`NO_TOP_LEVEL_PREFIX`) — a **different, non-overlapping** vocabulary
from `@repo/shared`'s `SkipReason` (`SKIPPED_TOO_LARGE` etc.), which describes Prompt
2's own filter pipeline declining to _index_ a file that the extractor already
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
the worker — not this phase's job to _deploy_, but worth knowing it is no longer
secretly broken if a later phase needs it.

---

# Phase 03 — Prompt 2 Decision Log

Continues the log above. Prompt 2 builds ignore-rules, file-classifier, the tree walker,
batched persistence, `IndexJob` tracking, the `repository-index` Inngest function, the
stale-index sweeper, and the two API routes — everything Prompt 1's "What Prompt 2
inherits" section named. Same convention: what was decided, what could not be verified,
and where the phase document turned out to be wrong.

## 0. Inherited baseline (verified before writing any Prompt 2 code)

Every command run against the tree as Prompt 1 left it (`d8f1269`), before a single line
changed:

| Command                                                              | Result                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git branch --show-current` / `git status`                           | `phase-03-repository-indexing`, clean                                                                                                                                                                                                                                                                                                                     |
| `pnpm install`                                                       | Already up to date                                                                                                                                                                                                                                                                                                                                        |
| `pnpm db:generate`                                                   | Prisma Client 7.9.1 regenerated cleanly                                                                                                                                                                                                                                                                                                                   |
| `pnpm lint`                                                          | Pass                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm typecheck`                                                     | Pass — 7 tasks                                                                                                                                                                                                                                                                                                                                            |
| `pnpm test:unit`                                                     | Pass — 20 files, 377 tests                                                                                                                                                                                                                                                                                                                                |
| `pnpm build`                                                         | Pass — 7 tasks                                                                                                                                                                                                                                                                                                                                            |
| `pnpm test:integration`                                              | Pass — 7 files, 106 tests (Testcontainers Postgres; Docker available)                                                                                                                                                                                                                                                                                     |
| `prisma migrate status` (against the configured Neon `DATABASE_URL`) | `P1001: Can't reach database server` — this environment cannot reach the Neon endpoint in `packages/db/.env`; **not** a claim the schema is out of sync. `prisma migrate deploy` against a local Testcontainers/`docker compose` Postgres (used throughout this prompt's own live verification, §7 below) applied all four migrations cleanly every time. |

Read in full, per the prompt's own instructions: `docs/decisions/phase-03-log.md`'s
Prompt 1 section; `tarball-fetcher.ts`/`archive-extractor.ts`'s exported signatures and
guarantees; `packages/db/prisma/schema.prisma`'s `RepositoryFile`/`IndexJob` models as
actually migrated; `apps/worker/src/lib/config.ts`; `apps/worker/src/inngest/{client,events}.ts`
and `middleware/logging.ts`; `apps/api/src/inngest/emit.ts`'s `TODO(phase-03)`. Nothing
in any of them contradicted what Prompt 1's own "What Prompt 2 inherits" section
promised — the fetcher/extractor signatures, the schema's exact columns/indexes, and the
`LoggingMiddleware` dual-hook AsyncLocalStorage constraint were all exactly as described,
and the last of those turned out to matter again directly (§5 below).

## 1. Installed-package behavior verified by reading, not assumed

| Package                                                              | What was verified, and how                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inngest@4.18.1`                                                     | `Middleware.WrapFunctionHandlerArgs`/`WrapStepHandlerArgs` both carry a full `ctx` (including `ctx.event`), read from `node_modules/inngest/components/middleware/middleware.d.ts` directly — this is what makes `JobTrackingMiddleware`'s event-derived `repositoryId`/`projectId` propagation possible (§5). `Cancellation.match` is marked `@deprecated` in favor of `.if` in the same file — `repository-index.ts` uses `if`, not `plan.md` §27.3's own example, which still shows the deprecated form (§8, "where the phase document is wrong"). `ConcurrencyOption`'s tuple form (`RecursiveTuple<ConcurrencyOption, 2>`) is exactly two entries, confirmed against the type before writing the `[{key:...}, {limit:20}]` config. `onFailure` is a same-level `InngestFunction.Options` field (not a third `createFunction` argument, as some Inngest example code elsewhere might suggest) — confirmed in `components/InngestFunction.d.ts`, and confirmed _live_: it registers as a second, `(failure)`-suffixed function, triggered internally on `inngest/function.failed` filtered to the parent's function id (§7's live registration dump shows this exactly). Its context is a `FailureEventArgs`-shaped `ctx.event.data.event.data` (the _original_ triggering event, nested), `ctx.event.data.run_id`, and `error: Error` reconstructed from Inngest's own `JsonError` schema (`{name, message, stack, cause?}` — `types.d.ts`'s `baseJsonErrorSchema`/`JsonError`) — this is what drove the "encode the code in `.message`, not `.cause`" decision in §7 below, since `.cause` surviving that round trip could not be verified without a live Inngest Cloud account (only the Dev Server was reachable here) and `.message` is a guaranteed, non-optional field. Step outputs are typed through Inngest's own `Jsonify` transform, which — verified the hard way, via a real `tsc` error rather than documentation — **drops a `bigint` field entirely** rather than coercing it; `repository-index.ts`'s `target.installationId` had to be threaded through as a decimal string across the `resolve-target` step boundary for exactly this reason (§7). |
| `ioredis@6.0.0`                                                      | Same `RedisOptions` shape `@repo/github`'s own client already relies on (`lazyConnect`/`connectTimeout`/`maxRetriesPerRequest: 1`/`enableOfflineQueue: false`), reused verbatim for `apps/api/src/lib/redis.ts` (§6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `@prisma/client@7.9.1`'s raw-SQL helpers                             | `Prisma.sql`/`.join`/`.raw`/`.empty` are re-exports of `runtime.sqltag`/`runtime.empty`/`runtime.join`/`runtime.raw`, confirmed by reading `packages/db/src/generated/internal/prismaNamespace.ts` directly — this is what let `repository-file.repository.ts`'s batched upsert (§3) use genuine parameterized multi-row `INSERT ... VALUES (...), (...), ...` composition rather than reaching for `$queryRawUnsafe` or string interpolation (forbidden outright by `plan.md` §35.11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/db/src/generated/client.ts` vs `packages/db/src/client.ts` | Confirmed by reading both directly: the **generated** `client.ts` (Prisma's own output) has no side effects at module-load time — it only exports classes/types/the `Prisma` namespace. The **hand-written** `client.ts` (this package's own wrapper) is what reads `process.env.DATABASE_URL` and throws if it is unset, at `new PrismaClient(...)` construction. `packages/db/src/index.ts`'s barrel re-exports `prisma` from the hand-written file, so **any** import of `@repo/db` — even one that only wants a type from the generated file — evaluates the hand-written wrapper's throw too, since ES module barrel re-exports evaluate every listed source, not just the binding the importer actually uses. This is the mechanism behind two separate, real discoveries in this prompt: `file-classifier.ts` could not safely import the real `FileClassification` Prisma enum (§2), and `stale-index-sweeper.test.ts` needed an explicit mock of `repository.repository.ts` that `repository-index.test.ts` happened not to need, for reasons that had nothing to do with either test's own correctness (§7's own note on this).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The Inngest Dev Server (`inngest-cli@1.43.0`, via `pnpm dlx`)        | Live-verified end to end — see §7. Exposes `GET /dev` (registered function list, including cron/concurrency/cancel config as actually parsed) and `GET /v1/events/:id/runs` (per-run status) on `:8288`; events are sent to `POST /e/:key` in dev mode with any string as `:key`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 2. Sub-task 2.1/2.2 — `FileClassification` had to leave `@repo/db` before it ever arrived

Prompt 1's own "What Prompt 2 inherits" section didn't anticipate this, and it is worth
recording precisely because it reads, in isolation, like the opposite of what actually
happened: `FileClassification` **is** a real Postgres/Prisma enum (unlike
`indexState`/`skipReason`/etc., which are plain `String` columns whose legal values are
pinned in `@repo/shared` by Prompt 1's own design, §6 of the Prompt 1 log). The natural
instinct was therefore to re-export the _real_ generated enum from `@repo/db`'s public
surface for `file-classifier.ts` to import.

That failed the moment `file-classifier.test.ts` ran: importing `@repo/db` for _any_
reason evaluates its barrel, which evaluates the hand-written `client.ts`, which throws
`Error: DATABASE_URL is not defined` in a pure-function unit test that has and should
have no database configuration at all (§1's table above has the full mechanism). Two
fixes were available — set `DATABASE_URL` globally for every worker unit test, or
decouple the _type_ from the package that carries the connection. The second is
strictly better: it does not paper over a real coupling with an environment variable a
future reader would not know was load-bearing. `FileClassification`'s string values are
mirrored in `packages/shared/src/indexing.ts` (`FILE_CLASSIFICATIONS`), matched
literal-for-literal against `schema.prisma`'s enum, with the reasoning above written
directly into that file's own header comment so the next person who wonders "why isn't
this just imported from `@repo/db`" finds the answer at the point of the type, not only
here. `apps/worker/src/indexing/persistence/repository-file.repository.ts` (the one
`*.repository.ts` file that actually writes this column) is the only place that imports
the real generated enum, and passes a `@repo/shared` value into a Prisma `data` field
with no cast — the two unions are structurally identical.

## 3. Sub-task 2.1 — ignore-rules: the two-tier skip semantics, and the performance choices

`HARD_IGNORE_PATTERNS` is `plan.md` §8.2 step 4's own array, reproduced verbatim as one
exported constant — the "one place, data, not scattered `if`s" requirement from §16. Each
pattern is compiled to a `RegExp` once at module load via `micromatch.makeRe`, not
per-path — the "do not compile a glob per path per pattern" requirement from the phase
document, satisfied literally rather than trusted to `micromatch.isMatch`'s own internal
caching.

**Hard-ignore vs. `.gitattributes`-declared generated/vendored are two different kinds of
"skip", and conflating them is the single easiest way to get this module wrong
backwards** (this is written into the module's own header comment, not just here, because
it is exactly the kind of distinction a later "cleanup" silently inverts): a hard-ignore
match gets **no `RepositoryFile` row at all** (structural exclusion — `node_modules/**`
can be 90% of a repository's raw file count, §22/`plan.md` §43.2, and giving each of
those a row would be pure write amplification for zero downstream value). A
`.gitattributes` `linguist-generated`/`linguist-vendored` match **gets a row**, marked
`SKIPPED` with `SKIPPED_GENERATED`/`SKIPPED_VENDORED` — it is a targeted, per-file signal
a maintainer wrote on purpose, and the PR pipeline needs to know the file exists and why
it wasn't indexed (§4 FR), the same reasoning every other skip stage gets a row for.

**A performance optimization not asked for explicitly, but implied by "do not compile a
glob per path per pattern" taken to its logical end**: `isHardIgnoredDirectory` (added
alongside `isHardIgnored`) answers "would everything under this directory be hard-ignored
anyway" by testing one synthetic child path against the same compiled pattern set — sound
specifically because every _directory-anchored_ hard-ignore pattern matches any path
under it, and no _extension_-anchored pattern can false-positive against a probe name
with no extension. `walk-tree.ts`'s directory walk uses this to prune a committed
`node_modules` tree whole (never opening it) rather than rejecting each file inside it
individually — the difference between walking past one directory entry and walking
hundreds of thousands of them.

**`.gitattributes` pattern anchoring — a real, user-visible bug caught by the module's own
test suite, not shipped and found later**: real `.gitattributes` (like `.gitignore`)
treats a pattern with no interior `/` as unanchored (matches at any depth), while
`micromatch` has no such implicit rule — a bare `*.pb.go linguist-generated` line, the
single most common real-world `.gitattributes` shape, would have silently matched nothing
below the repository root. `toAnchoredGlob` normalizes a slash-free pattern to a
`**/`-prefixed one before compiling, verified directly by a test asserting the _before_
behavior would have failed (`service.pb.go` at the root vs. `api/v1/service.pb.go`
nested — both must match the same bare pattern).

**Nested `.gitattributes` cascading is out of scope**: only the repository-root
`.gitattributes` is read (`walk-tree.ts`). Real git resolves attributes with per-directory
`.gitattributes` files cascading down the tree, which is meaningfully more machinery for
a case that, for the `linguist-generated`/`linguist-vendored` subset this phase cares
about, is rare in practice (these are almost always declared once, at the root, precisely
so they apply repo-wide). Flagged as a known, accepted gap rather than silently absent.

59 tests for `ignore-rules.ts` alone (every hard-ignore category, the order being
observable, `.gitattributes` parsing including the anchoring fix, last-match-wins
semantics, and the combined `classifyIgnore` decision).

## 4. Sub-task 2.2 — file-classifier: the deliberate false-negative bias, made structural

Every heuristic (size cap, binary sniff, minified average-line-length) is implemented
exactly to §10's letter, in the specified order, with the boundary cases §14 names tested
directly (512 KB exactly is _not_ over the cap; a NUL byte at sniff-window offset 8191 is
detected, one at offset 8192 — one past an 8 KB window — is not, by construction, since
this module never reads past what it is given; one very long line among many short ones
is _not_ minified, only a genuinely low average is). `classify`'s own doc comment states
the bias explicitly, matching §22: a binary file that slips past the NUL-byte sniff still
gets indexed and is re-checked by Phase 04's real parser (contained, recoverable); a text
file wrongly flagged binary disappears from review context entirely with nothing to
re-check it. No heuristic beyond the two the phase document names was added, specifically
because a third heuristic's false-positive side would only ever make the worse failure
mode (silent disappearance) more likely, not less.

`packageName` resolution (§7 of Prompt 1's log flagged this as Prompt 2's decision to
make) stays at the **directory-path** level, not a parsed `package.json` `"name"` field —
`detectPackageName` takes a pre-sorted (longest-first) list of package-root directories
and returns the nearest ancestor's _path_. Reading and parsing every `package.json` for
its declared name is real, additional work with no consumer in a files-only phase;
`@@index([repositoryId, packageName])` only needs a stable grouping key, and a directory
path is one. Phase 04's monorepo work (`plan.md` §8.2's own note: "detect workspace
roots... store packageName") can upgrade this to a parsed name without a schema change.

## 5. Sub-task 2.3 — the tree walk: hashing contract, FAILED-row placeholder, and the health note

**`contentHash` is `sha256` of the file's raw, extracted bytes — no line-ending or BOM
normalization, and this is a documented contract, not a default nobody chose.**
`git archive` (what produced this tree) already applies the repository's own
`.gitattributes` `text`/`eol` normalization before this code ever sees a byte, so
re-normalizing here would risk silently disagreeing with `git show`'s own idea of the
same blob's content. `walk-tree.ts`'s header comment states this explicitly because Phase
05 (embedding-cache key) and Phase 14 (incremental-indexing key) both have to hash their
own inputs the identical way for this to mean anything — an assumption is not enough; the
next reader needs to find the actual promise written down.

**A `FAILED` row's `contentHash` is a documented placeholder (`sha256` of the empty
buffer), not a real content hash, and `indexState=FAILED` is the signal a consumer must
check first.** An unreadable file cannot be hashed; the column is `NOT NULL`. Rather than
inventing a fake-but-plausible value, the well-known empty-string hash is used
specifically because it is recognizable as a sentinel by anyone who looks it up, and the
`indexState` column is the actual authority on whether to trust it. **Flagged for Phase
14 specifically**: its incremental-indexing logic must special-case `FAILED` rows
(always re-attempt) rather than comparing this placeholder hash for equality — a `FAILED`
row and a genuinely empty file would otherwise hash identically and be treated as
"unchanged".

**The repository-health note (§16/§22, the committed-`node_modules` case)** is a
`logger.warn` at `hardIgnoreRatio > 0.5` (and `pathsConsidered > 100`, so a five-file toy
repository where one is hard-ignored does not trip it) — a distinct, greppable log line,
separate from the ordinary per-run completion line, so it is discoverable without parsing
every run's aggregate counts. Computing `hardIgnoredCount` precisely (rather than
approximating it as "whatever wasn't in the candidate list") costs one extra recursive
`readdir` pass over each _pruned_ subtree specifically — accepted, because that pass is
cheap directory listing, not the expensive per-file classify/hash pipeline pruning exists
to avoid, and losing the exact count would blind the one signal §22 asks this phase to
surface.

10 tests for `walk-tree.ts`, each against a real temporary directory (never mocked
filesystem calls) — an ordinary indexed file, a hard-ignored subtree (with package-root
pollution from inside it proven absent), a `.gitattributes`-generated file, an over-cap
file (hash proven correct via a real streamed read), a binary file, a minified file, a
genuinely unreadable file (via `chmod 000`, not a directory-swap trick — the first
attempt used a directory swap and was self-caught: replacing a file with a directory
makes the walker see an empty subdirectory, not a failed read), monorepo package-root
resolution, the health-note log line, and the empty-repository edge case (no
division-by-zero in the ratio).

## 6. Sub-task 2.4 — the upsert strategy, chosen against two rejected alternatives, and the stale-row sweep the phase document never mentions

Recorded at length in `repository-file.repository.ts`'s own header comment; summarized
here with the verification evidence. Three options for "upsert `RepositoryFile` rows,
batched, 1,000 to a statement" (§4 Technical Requirements):

1. `createMany({ skipDuplicates: true })` — rejected outright. `skipDuplicates` skips, it
   does not update; a file whose content changed between two indexes of the same path
   would silently keep its stale `contentHash` forever. Wrong, not merely slow.
2. A transaction of per-row `prisma.repositoryFile.upsert(...)` calls — correct, but
   exactly the "one write per file" pattern §4 names as a Phase 3 failure point, just
   wrapped in a transaction.
3. **Chosen**: `INSERT ... ON CONFLICT ("repositoryId","path") DO UPDATE SET ...` via
   `$executeRaw`, batched 1,000 rows per statement, every value bound through
   `Prisma.sql`/`Prisma.join` (never string-interpolated, per `plan.md` §35.11). `id` is
   generated in JS (`randomUUID()`) because the column has **no database-level
   default** — confirmed by reading the migration SQL directly (`"id" TEXT NOT NULL`,
   nothing else); Prisma's `@default(uuid())` is client-side codegen only. On conflict,
   the freshly-generated id is simply discarded, since it is not part of the conflict
   target and not in the `SET` clause — the existing row keeps its original identity.
   `parseState`/`symbolCount`/`inboundEdgeCount` are deliberately absent from **both**
   the column list and the `SET` clause, so a Phase-03-only re-index of an
   already-Phase-04-parsed repository does not clobber that work back to defaults.

**The stale-row sweep is the gap the phase document does not mention at all**: nothing in
§7's own instructions (Prompt 1's log) or the phase document's own text addresses what
happens to `RepositoryFile` rows for paths that existed in a previous index but were
deleted from the repository before the next one. Without a sweep, §14's "counts match
`git ls-files`" verification would drift wider on every second index of a repository with
any file churn. `sweepStaleRepositoryFiles(repositoryId, targetCommitSha)` runs a plain
`deleteMany({ where: { repositoryId, commitSha: { not: targetCommitSha } } })` **after**
every current-commit batch has committed — every row this run touched was just upserted
with `commitSha = targetCommitSha`, so anything left at an older `commitSha` is
unambiguously stale.

**Verified live against a real Postgres (Testcontainers)**, not just unit-asserted
against mocks — matching this codebase's own "no unit tests for `*.repository.ts` files,
they get real integration coverage" convention (confirmed by checking:
`apps/api/src/modules/repositories/repository.repository.ts`/`installation.repository.ts`
have no `*.test.ts` files of their own, only `tests/integration/` coverage). A throwaway
script (never committed) exercised: a 3-file initial insert; a re-index at a new commit
where one file's content changed (contentHash updated in place, row `id` preserved
across the upsert — proven, not assumed), one file was unchanged, and one was deleted
(swept — exactly 1 row removed, confirmed); and a 2,500-row batch to exercise the
multi-batch path for real. All assertions passed on the first real run against a live
database.

## 7. Sub-task 2.5 — IndexJob: the compressed lifecycle, the counter definitions, and job-tracking middleware's actual scope

**`IndexJob.status` never passes through `PENDING` in this implementation**, despite §11's
documented `PENDING → RUNNING → SUCCEEDED|FAILED` diagram. `createIndexJob` inserts the
row already `RUNNING`. Argued in the module's own header comment: the earliest safe
moment to create the row at all is _after_ the locking `UPDATE` has confirmed this run
actually won the lock (creating it before that confirmation would mean unwinding an
orphan row on the "zero rows affected, exit gracefully" path); by the time it is safe to
create, the run has unambiguously started. `PENDING` remains a legal value in
`@repo/shared`'s `IndexJobStatus` union — this phase's writer simply never produces it. A
genuine, deliberate deviation from the literal diagram, not an oversight; recorded here
because it is the kind of thing a future reader would otherwise "fix" by adding a
`PENDING` row nobody asked for.

**Counter definitions — binding, because §14's reconciliation check depends on them being
exact, not merely reasonable**: `filesTotal = filesIndexed + filesFailed + filesSkipped`
(never includes hard-ignored paths, which get no row at all). `filesProcessed =
filesIndexed + filesFailed` — "processed" means _attempted to completion_, successfully
or not, which is what makes §12's own table ("visible in filesSkipped/filesProcessed
counts" for a `FAILED` file) literally true when `FAILED` folds into `filesProcessed`
rather than `filesSkipped`. `filesSkipped` is _only_ files excluded by policy
(size/binary/minified/generated/vendored) that the pipeline never attempted to read for
indexing purposes. `indexer.service.ts`'s `countByBucket` is where this definition is
actually applied to a walk's results — the three raw buckets (`filesIndexed`,
`filesFailed`, `filesSkipped`) are kept separate all the way up, because
`Repository.indexedFileCount` (successfully-indexed only) and `IndexJob.filesProcessed`
(indexed _and_ failed) genuinely need different subsets of the same walk.

**`attempts` tracking — a real design problem solved by reading `ctx.attempt`'s actual
semantics rather than guessing**: Inngest replays a function's handler from the top on
every retry, re-executing memoized steps from cache rather than for real. A `step.run`
placed early to "count this attempt" would therefore only ever execute for real on the
_first_ attempt (the one that succeeds and gets memoized) — exactly backwards.
`repository-index.ts` instead calls `indexJobRepository.incrementAttempts` inside a step
whose **id itself includes `ctx.attempt`** (`record-attempt-${attempt}`) and only when
`attempt > 0` — a genuinely new, never-before-seen step id on every real retry, which
Inngest therefore executes for real rather than replaying from memory. Verified live
(§8): a run that failed 3 times ended with `attempts: 4` in Postgres, matching `retries:
3` (1 initial + 3 retries) exactly.

**`job-tracking.ts`'s actual scope is narrower than its name might suggest, and that is
deliberate**: it propagates `repositoryId`/`projectId` from the triggering event onto the
trace context, in both `wrapFunctionHandler` and `wrapStepHandler` — the identical
dual-hook requirement `logging.ts`'s own doc comment already established (AsyncLocalStorage
does not survive from the function-level hook into a step callback). It does **not**
write anything to Postgres — `IndexJob` writes stay in `index-job.repository.ts`, called
explicitly from `repository-index.ts`'s own step bodies, keeping "which files touch
Prisma" answerable by grepping for `*.repository.ts` alone (Rule B). It also does **not**
propagate `indexJobId` — that value does not exist at event-fire time (only after step 1
creates it), so there is no moment before the function body runs when middleware could
know it; `repository-index.ts`'s own log calls include it explicitly instead. Verified
live: every log line during the real test run in §8 carries `repositoryId`/`projectId`
automatically, confirming the merge-onto-existing-context design (reading whatever
`LoggingMiddleware` already established, rather than generating a second, different
`traceId`) works correctly in the registered order (`[LoggingMiddleware,
JobTrackingMiddleware]`).

5 tests for `job-tracking.ts` (both hooks independently, trace-id preservation, the
defensive no-event-data no-op, and the outside-any-context fallback). Verified live
against real Postgres separately (§8's E2E run): `createIndexJob`/`incrementAttempts`/
`updateProgress`/`markSucceeded`/`markFailed`/`markSucceededNoOp` all behaved exactly as
documented, including the reconciliation invariant holding on a real `markSucceeded` call
(`filesProcessed + filesSkipped === filesTotal`).

## 8. Sub-task 2.6/2.7 — the orchestration seam and the Inngest function, live-verified against a real Dev Server

**`indexer.service.ts` composes fetch→extract→walk→persist as one Inngest-agnostic
function**, taking an already-resolved SHA (matching `fetchTarballStream`'s own
precedent) and reporting progress through an injected `onProgress` callback at three
coarse checkpoints (download start, extraction/walk done, persistence done) rather than
per file — a deliberate cadence choice against write amplification, argued in the
module's own doc comment. Temp-directory ownership has exactly one owner
(`archive-extractor.ts`, per Prompt 1's own design) — this module never calls
`fs.mkdir`/`fs.rm` itself. 5 tests, using a real crafted tarball through the real
extractor and walker, with only the persistence layer mocked (matching the
`*.repository.ts`-files-aren't-unit-tested convention) — including a full pipeline run
with real progress-checkpoint ordering asserted, and the reconciliation invariant proven
end to end against a mixed INDEXED/SKIPPED fixture.

### The two-vs-three-GitHub-calls decision (see §11 below for the fuller argument)

`repository-index.ts`'s step 2 uses the `Repository` row's own **stored**
`owner`/`name`/`defaultBranch` (fresh from Phase 02's connect-time `GET /repos` call)
rather than re-fetching metadata at index time — one `getHeadCommit` call plus one
tarball fetch, two calls total, matching §9/§14/§15's repeatedly-stated acceptance
criterion rather than §8.2's own step-2 wording (which describes a metadata re-fetch
`plan.md` did not anticipate this codebase already caches from connect). The narrow,
accepted staleness risk this creates (a default branch _renamed_ without the old one
being deleted would go undetected until the stale sweeper or a webhook, not this call) is
recorded, not hidden.

### `GithubRateLimitError` is the one failure that does not throw `NonRetriableError`

Every other classified failure (`UnsafeArchiveError`, `ArchiveTooLargeError`,
`GithubAccessRevokedError`, the tarball-fetcher's own `REPO_NOT_FOUND`/`UNSAFE_REDIRECT`
result variants) throws `NonRetriableError` **from inside the step's own callback** —
confirmed, by reading `NonRetriableError`'s own doc comment ("indicates to Inngest that
the function should cease all execution") and by the live run in this section, that this
is what actually stops Inngest's automatic per-step retry rather than merely being caught
by surrounding code. A rate limit is different: §8/§12 specify `step.sleepUntil(resetTime),
resume` as _the_ retry mechanism, not Inngest's own blind exponential backoff — so
`runFetchExtractPersist` returns a `{ rateLimited: true, retryAfterSeconds }`
**successful** step result instead of throwing, and the function handler turns that into
a real `step.sleepUntil` call followed by a fresh retry attempt under a new step id
(`fetch-extract-persist-retry-${n}`), capped at `MAX_RATE_LIMIT_SLEEPS = 5` as an explicit
safety valve. 13 unit tests cover every classified branch plus the plain-error pass-through.

### The error-code-in-message convention, and why `.cause` was not trusted

`onFailure` runs as a wholly separate invocation with no closure over the main handler —
it only receives the final `Error` after Inngest's own `JsonError` serialization
(`{name, message, stack, cause?}`). `.message` is the one field guaranteed to survive
that round trip; `.cause` surviving it could not be verified from this environment (no
Inngest Cloud account reachable, only the Dev Server). So every throw site encodes its
`IndexErrorCode` as a `"CODE: message"` prefix on `.message` itself (`withCode`), and
`onFailure` parses it back out (`parseCode`), falling back to `"UNKNOWN"` for anything
unrecognized — including, correctly, a plain transient `Error` whose retries were
exhausted without ever having been classified. `ACCESS_REVOKED` was added to
`@repo/shared`'s `IndexErrorCode` union for `GithubAccessRevokedError` specifically
(`plan.md` §27.5 rule 5 names "installation revoked" as a case that must not retry, and
no existing code represented it); `UNSAFE_ARCHIVE` is deliberately reused for
`UNSAFE_REDIRECT` (same "looks tampered with, abort, no detail past this code" threat
class) rather than inventing a fifth code for a case this narrow.

### `onFailure` is the single place every failure path converges on a terminal write

Per `plan.md` §27.7 ("every function writes a terminal status row"): `onFailure` looks up
the `IndexJob` by `inngestRunId` (the reconnection mechanism `createIndexJob` stores it
for, exactly for this purpose — there is no other way for a separate invocation with no
closure to find "its" job), marks the `Repository` row `FAILED` unconditionally, and
marks the `IndexJob` `FAILED` if one was ever created. This is what let every
`NonRetriableError`/exhausted-retry throw site stay simple (just throw, with a coded
message) rather than each one separately writing terminal state before throwing.

### Live verification against a real Inngest Dev Server and real Postgres — what was actually observed, not merely asserted

Docker Postgres/Redis, the compiled worker under `tsx`, and `inngest-cli@latest dev
--no-discovery` were run together for this. `GET /v0/functions` (worker) and `GET /dev`
(dev server) both confirmed **live** registration: `repository-index` with its exact
`concurrency`/`cancel`/`timeouts` config as parsed by Inngest itself (not merely as
written), plus the auto-registered `repository-index (failure)` sub-function; after §9's
work, `stale-index-sweeper` with `{"cron": "0 */6 * * *"}` parsed correctly.

A real `Repository` row was seeded (fake GitHub App credentials — no real installation
exists, per Prompt 1's own "Outstanding" list, unchanged) and a real
`repository/index.requested` event sent through the Dev Server's ingestion endpoint.
Observed, end to end, from the worker's own structured logs and direct Postgres reads:

- The lock, job creation, and `resolve-target` step ran correctly, with
  `repositoryId`/`projectId` present on every log line (confirming §7's `JobTrackingMiddleware`
  design lands correctly in a real Inngest execution, not just in its own unit tests).
- Token minting failed at the crypto layer against the placeholder private key (expected —
  it is not a real RSA key), retried 3× internally by `app-auth.ts` exactly as that
  module documents, then correctly classified as `UNAVAILABLE` by `getHeadCommit` (its
  own doc comment's prediction — `classifyGithubError`'s duck-typing finds no `.status`
  on `GithubRateLimitError`/`GithubAccessRevokedError`, so a token-mint failure collapses
  into the generic transient reason) and thrown as a plain, uncoded `Error` — exactly the
  intended "let Inngest retry normally" path.
- Inngest retried the step automatically; after the 3rd retry (4th total attempt,
  matching `retries: 3`), the run reached terminal `Failed` and `onFailure` fired —
  observed via a `"repository-index failed terminally"` log line and, directly in
  Postgres, `Repository.indexStatus = "FAILED"` with `indexError = {code: "UNKNOWN",
message: "..."}`, and `IndexJob.status = "FAILED"`, `attempts: 4`, `currentStep:
"failed"`, the identical `error` shape.
- **One unexplained observation, flagged rather than silently resolved**: the Dev
  Server's own log showed more `"error handling queue item": "invalid status code: 500"`
  entries (8, over roughly 6 minutes) than the worker's own structured logs showed actual
  step invocations (2, both accounted for above). The _outcome_ was correct in every
  respect checked (final attempt count, final state, final error shape all matched
  `retries: 3` exactly), so this reads as Dev-Server-side transport/queue-retry noise
  distinct from the function's own step-retry budget, not a bug in this phase's code —
  but it was not fully explained from this environment (no access to Inngest Cloud, no
  source access to `inngest-cli`'s own queue internals), and is recorded as exactly that:
  an open question for Prompt 3 or a real Inngest Cloud deployment to resolve, not a
  claim it is definitely benign.
- **Lock concurrency, verified directly against real Postgres, not simulated**: with the
  repository reset to `PENDING`, two genuinely concurrent (`Promise.all`) calls to
  `acquireIndexingLock` resolved to exactly one `{acquired: true}` and one `{acquired:
false}`; a third call afterward (repository now `INDEXING`) also correctly returned
  `{acquired: false}`.

**What this live session did _not_ cover, honestly**: the full happy-path
fetch→extract→walk→persist→terminal-INDEXED pipeline never ran against a real GitHub
tarball, because no real GitHub App installation exists in this environment (unchanged
from Prompt 1's own "Outstanding" list). Only the failure path (token mint → transient
error → retry → exhaustion → `onFailure`) was observed live; the success path is covered
by `indexer.service.test.ts`'s crafted-tarball tests and by direct, real-Postgres
verification of every persistence function individually (§6/§7), but not as one
continuous live Inngest run. The `GithubRateLimitError`/`step.sleepUntil` loop is
unit-tested (§ above) but was never triggered live, for the same reason. **Both are named
explicitly in "What Prompt 3 inherits" (§14) as needing real coverage.**

## 9. Sub-task 2.8 — the API routes: the `indexJobId` pre-allocation, and the two response shapes

**`POST /index` must answer `{ indexJobId }` synchronously (§7), but the worker's step 1
is the only writer of `IndexJob` — a genuine gap the phase document does not address at
all.** Two ways to close it: have the API itself create a `PENDING` `IndexJob` row before
emitting the event (rejected — it would resurrect the very `PENDING`-row-with-no-real-moment
problem §7 above already argued out of existence, and would duplicate lock/creation logic
between two deployables), or have the API pre-generate the id and thread it through the
event for the worker's own `createIndexJob` to adopt (**chosen**).
`RepositoryIndexRequestedData.indexJobId?: string` (optional — the `connectRepository`
path, untouched by this prompt, has no synchronous caller waiting on an id, so it
continues to let the worker generate its own). The accepted race this leaves open — the
pre-allocated id can go unused if this run loses the lock to a genuinely concurrent one —
is low-consequence because _neither_ `POST /index`'s response nor `GET /index-status`
requires the client to poll _by_ that id; `/index-status` is scoped to the repository, not
the job.

**`getIndexStatus` falls back to the `Repository` row's own `indexStatus`/`indexError`
when no `IndexJob` exists yet**, rather than 404ing or returning null — a repository
between "just connected" and "the worker's step 1 has run" genuinely has no job row (the
worker never writes `PENDING`, §7 above), and without this fallback the very first poll
after a connect would have nothing meaningful to show. `Repository.indexError` (a column
that existed but was never selected before this prompt) was added to `REPOSITORY_SELECT`/
`RepositoryRecord`/`RepositoryDto` specifically to make this fallback possible and to
surface a specific failure reason on the repository detail view generally.

**Two response DTOs, not one reused across both endpoints, on purpose**: §7 names exactly
six fields for `GET /index-status` (no `id`, no `filesSkipped`) — a genuinely cheap-poll
shape, and a repository with no job yet has no real `id` to report at all (a `""`
placeholder was tried first and rejected as dishonest). `IndexJobSummaryDto` (with `id`
and `filesSkipped`) is what `GET /api/repositories/:id`'s `indexJob` field uses instead —
that endpoint is not the cheap-poll one, and a UI showing repository detail benefits from
the fuller shape.

**Rate limiting: a second, separate Redis client, not a reuse of `@repo/github`'s own.**
`getRedisClient` is not part of `@repo/github`'s public surface (deliberately — token-cache
internals stay internal), and reusing it would mean `apps/api` importing `@repo/github`
for a purpose with nothing to do with GitHub. `apps/api/src/lib/redis.ts` is a second,
small client construction, built the identical verified way (`lazyConnect`/
`connectTimeout`/`maxRetriesPerRequest: 1`/`enableOfflineQueue: false`), both pointed at
the same `REDIS_URL`. `apps/api/src/lib/rate-limit.ts` is a fixed-window counter (`INCR` +
`EXPIRE` on first increment) scoped to exactly this one route's 10/hour/repository limit
— no general rate-limiting middleware was built, per the prompt's own instruction, with
what a general version would look like (a `withRateLimit` option on `withRoute`, matching
`component`) recorded in the module's own header comment rather than built speculatively.
**Fails open** on a Redis error (logs a warning, allows the request) — the same
availability-over-strict-correctness choice `@repo/github`'s token cache already makes,
for the same reason: a rate limit is an abuse guard, not a security control, and a Redis
blip should not turn into an outage of a feature that has nothing to do with Redis.

**§7's error tables list "403, 404" for `GET`/`POST` on these two routes; the actual
behavior is 404-only**, following this codebase's own already-established
`requireTenantAccess` convention (phase-01-log §16, re-confirmed phase-02-log §18) — not
a new divergence this prompt introduces, but a continuation of one Prompt 1 (and the
phases before it) already settled and this prompt's routes simply inherit by using the
same tenancy helper every other route uses.

41 tests for `repository.service.ts` (up from 32 — `getRepositoryDetail`'s widened
`indexJob`, `getIndexStatus`'s two branches, `triggerIndex`'s success/409/429/404/
defensive-mode-guard paths), 4 new schema tests for the explicit `INCREMENTAL` rejection
branch, and 12 new route-level tests (`GET /index-status`, `POST /index`, including the
`400` on `mode: "INCREMENTAL"` asserted at the HTTP layer, not just the schema layer).
`RepositoryDetail.indexJob`'s widening from literal `null` did exactly what Prompt 1's
log said it would: every existing call site that constructed a `RepositoryRecord`/
`RepositoryDto` fixture failed to compile until `indexError` was added, in three test
files plus the routes test file — the forcing function worked as designed.

**A narrow-mock fragility, caught and fixed, matching a pattern Prompt 1's own log
already named once**: `repository.service.test.ts`'s existing `vi.mock("@repo/github",
...)` was a narrow replacement (only `installationGithub`/`repositoryGithub` stubbed).
The moment `repository.service.ts` gained a transitive path to `lib/config.ts` (via the
new `lib/rate-limit.ts` → `lib/redis.ts` → `config/env.ts` chain), that narrow mock broke
every test in the file, because `lib/config.ts` imports `githubAppPrivateKeySchema` from
`@repo/github` and the mock didn't provide it. Fixed the same way Prompt 1's log recorded
for `@repo/observability`: widened to `importOriginal` and only override what the test
actually cares about, plus mocking `index-job.repository.js`/`rate-limit.js` directly at
their own seams so the test never needs to reach `lib/redis.ts` for real.

## 10. Sub-task 2.9 — the stale-index sweep, chosen over the outbox, and why

`emit.ts`'s own `TODO(phase-03)` named two options: a transactional outbox, or a
reconcile sweep. `plan.md` §27.2 independently names a `stale-index-sweeper` cron in its
own function catalogue, on its own — the outbox is not named anywhere in that catalogue
or in this phase's own §3 In Scope list. Built the sweep only: `apps/worker/src/inngest/
functions/stale-index-sweeper.ts`, `triggers: { cron: "0 */6 * * *" }` (matching
`plan.md` §27.2's own schedule exactly), `retries: 1`, `timeouts.finish: "5m"`. It finds
`Repository` rows `indexStatus = "PENDING"` with `updatedAt` older than 15 minutes
(`findStalePending`, worker-side `repository.repository.ts`) and re-emits
`repository/index.requested` for each, with a freshly pre-allocated `indexJobId` per
event (the identical mechanism §9 above gives `triggerIndex`) and a new `reason: "sweep"`
value added to `RepositoryIndexRequestedData`'s union.

**Why imprecise-on-purpose is fine here**: a repository whose real index is genuinely in
flight but has not yet flipped `indexStatus` away from `PENDING` looks identical, from
this query's point of view, to one whose event was actually dropped. Re-sweeping it is
harmless — `acquireIndexingLock` is the actual correctness guarantee, and a redundant
`repository/index.requested` for an already-running repository simply fails to acquire
the lock and exits gracefully, exactly as any other concurrent trigger would. The sweep
only ever needs to be a reasonable "probably stuck" heuristic, not a proof.

**The 6-hour cadence is a real, named trade-off, not free**: a genuinely dropped event
can sit unrecovered for up to 6 hours plus the 15-minute threshold. The alternative (an
outbox, catching this within seconds) is real infrastructure this phase does not build —
a table, a dispatcher, idempotent-send bookkeeping, touching every future event emission
in the codebase, not just this one. Recorded as a deliberate scope boundary, argued in
`stale-index-sweeper.ts`'s own header comment, revisitable if the 6-hour worst case ever
proves too slow in practice.

Verified live (§8's own live session, extended): `GET /dev` on the Inngest Dev Server
confirmed `stale-index-sweeper` registered with `{"cron": "0 */6 * * *"}` parsed
correctly by Inngest itself — catching a cron-string typo here would have meant a
function that silently never fires, exactly the failure mode this whole sub-task exists
to prevent for the _emit_ side. 3 unit tests for the pure, extracted `buildSweepEvents`
function (one event per stale repository with `reason: "sweep"`, a fresh `indexJobId`
per event, the empty-input case).

## 11. Where the phase document is wrong or under-specified

Continuing Prompt 1's numbered list (§14 of that section) rather than starting a fresh
one — same phase, same document, still being read against the same reality.

6. **§9's own summary text ("Two API calls per full index... metadata + tarball") directly
   contradicts its own preceding External Integrations table, which lists three separate
   endpoints** (`GET /repos/{o}/{r}`, `GET /repos/{o}/{r}/commits/{branch}`,
   `GET /repos/{o}/{r}/tarball/{sha}`), and §8.2 step 2's own wording ("`GET /repos/{o}/{r}`
   for `default_branch`, then `GET /repos/{o}/{r}/commits/{branch}` for head SHA")
   describes two calls before the tarball fetch even starts — three total. Meanwhile
   §14's Automated Verification and §15's Acceptance Criteria **both separately** assert
   "exactly two". The weight of evidence (three separate places all agreeing on "two",
   against one step's wording that is itself most likely inherited from `plan.md`'s more
   generic step spec without accounting for this codebase's Phase 02 already caching
   `owner`/`name`/`defaultBranch` at connect time) favors two as the intended design.
   Resolved by **not** re-fetching `GET /repos/{o}/{r}` at index time — see §8 above for
   the full argument and the accepted staleness trade-off this creates.
7. **§7's response tables list "403, 404" as possible errors for `GET`/`POST` on the two
   routes this prompt adds** — not followed, per the codebase's own already-settled
   404-only tenancy convention (phase-01-log §16, phase-02-log §18). Not a new
   divergence; this prompt's routes simply use the same `requireTenantAccess` every other
   route already uses.
8. **§8.2's step list (and this prompt's own instructions) never address what happens to
   `RepositoryFile` rows for paths deleted between two indexes of the same repository** —
   filled by the `commitSha`-based stale-row sweep, §6 above. Flagged as a real gap, not
   merely an implementation detail this prompt happened to add value on top of.
9. **Neither the phase document nor `plan.md` addresses how `POST /index`'s synchronous
   `{ indexJobId }` response is supposed to work, given the worker is the only writer of
   `IndexJob`** — filled by the pre-allocated-id-on-the-event mechanism, §9 above. This is
   the sharpest gap found this prompt: satisfying §7's literal contract required a design
   decision (thread an id through an event payload Prompt 1 already declared) that
   neither source document anticipates needing at all.
10. **`plan.md` §27.3's own `cancelOn` example uses `match`, which the installed
    `inngest@4.18.1` marks `@deprecated` in favor of `if`** — used `if` throughout,
    verified against the installed package's own types rather than the example's literal
    syntax (§1 above).

## 12. Outstanding — requires human action

Carried forward from Prompt 1's §15 (still open, unchanged by this prompt unless noted)
plus this prompt's own:

- [ ] **No real GitHub App has been registered.** Unchanged. Every live verification this
      prompt did against a real Inngest Dev Server used fake, syntactically-valid-only
      credentials — real enough to prove the _code paths_ (token mint attempted, failed,
      classified, retried, exhausted, `onFailure` fired) but not to prove a real tarball
      ever downloads and indexes successfully end to end.
- [ ] **No real installation exists, no repository has ever been connected against real
      GitHub, and — new this prompt — no real ~1,000-file repository has ever reached
      `INDEXED`.** This is the single biggest verification gap this prompt leaves open;
      see §8's own "what this live session did not cover" for the precise boundary of
      what _was_ checked (the failure path, live) versus what was not (the full success
      path, live).
- [ ] **The `GithubRateLimitError`/`step.sleepUntil` retry loop was never triggered
      live** — unit-tested only (§8). Triggering a real GitHub rate limit from this
      environment is not practical without a real installation.
- [ ] **The Dev-Server transport-retry anomaly noted in §8** (more `"invalid status
code: 500"` log lines than actual step invocations, outcome still correct) was not
      fully explained. Worth a second look against a real Inngest Cloud deployment,
      where the retry/queue machinery is the production implementation rather than the
      Dev Server's own.
- [ ] **CI still does not run.** Unchanged.
- [ ] **`pnpm format:check` still fails**, same pre-existing conflict. Untouched.
- [ ] **No staging environment exists.** Unchanged.
- [ ] **The worker has never registered with Inngest Cloud, only the local Dev Server.**
      Unchanged.
- [ ] **New this prompt: `stale-index-sweeper`'s cron has never actually fired on its
      real 6-hour schedule** — its registration and cron-string parsing were verified
      live (§10); its actual triggered execution (finding a genuinely stale row and
      re-emitting for it) was not, since provoking a 15-minute-stale `PENDING` repository
      and waiting was outside this session's practical time budget. `buildSweepEvents`
      (the pure, extracted logic) is unit-tested; the cron-triggered wiring around it is
      not.

## 13. Commits in this prompt

| Commit    | Sub-task                                                                                 |
| --------- | ---------------------------------------------------------------------------------------- |
| `cd561de` | 2.1 — hard-ignore rules + `.gitattributes`-based file classification (`ignore-rules.ts`) |
| `05d2690` | 2.2 — deterministic file-classifier (size/binary/minified, classification)               |
| `d787166` | 2.3 — the tree walk and content hashing pipeline (`walk-tree.ts`)                        |
| `7c5662d` | 2.4 — batched upsert `RepositoryFile` persistence with the stale-row sweep               |
| `459f8c6` | 2.5 — `IndexJob` persistence + the job-tracking trace-context middleware                 |
| `7c182a8` | 2.6 — `indexer.service.ts`, the Inngest-agnostic orchestration seam                      |
| `12b7c8b` | 2.7 — the `repository-index` Inngest function, live-verified against a real Dev Server   |
| `d5d9ea0` | 2.8 — `GET /index-status` and `POST /index` API routes                                   |
| `247f3fc` | 2.9 — `stale-index-sweeper` cron, resolving `emit.ts`'s `TODO(phase-03)`                 |

## 14. What Prompt 3 inherits

**Everything from Prompt 1's own "What Prompt 2 inherits" still applies transitively**
(the fetcher/extractor contracts, the `@repo/shared` type vocabulary) — this section
covers what Prompt 2 itself built on top.

**The full pipeline, module by module**, all under `apps/worker/src/indexing/`:
`filter/ignore-rules.ts` (`classifyIgnore`, `isHardIgnored`, `isHardIgnoredDirectory`,
`parseGitattributes`), `filter/file-classifier.ts` (`classify`, individual heuristic
functions, all pure), `walk-tree.ts` (`walkTree(rootDir, options) → WalkSummary`, pure
filesystem-in/structured-data-out), `persistence/repository-file.repository.ts`
(`upsertRepositoryFiles`, `sweepStaleRepositoryFiles`), `persistence/index-job.repository.ts`
(`createIndexJob`/`incrementAttempts`/`updateProgress`/`markSucceeded`/`markFailed`/
`markSucceededNoOp`/`findByInngestRunId`), `persistence/repository.repository.ts`
(`acquireIndexingLock`/`findIndexTarget`/`markIndexed`/`markFailed`/`findStalePending`),
`indexer.service.ts` (`indexRepository(options) → IndexRepositoryResult`, the one
function to call for a full index outside of Inngest). All are directly importable and
callable from a test with no Inngest runtime — this was the explicit design goal of
`indexer.service.ts`'s seam, and it is what Prompt 3's fixture/integration tests should
target for the parts of the pipeline this prompt could not verify live (§8/§12 above).

**`repository-index.ts`'s exported testable seams**: `runFetchExtractPersist` (the
fetch→extract→persist step body, pure aside from its `indexRepository` call),
`withCode`/`parseCode` (the error-code-in-message convention), both fully unit-tested.
The function itself: `id: "repository-index"`, `retries: 3`, `concurrency: [{key:
"event.data.repositoryId", limit: 2}, {limit: 20}]`, `timeouts.finish: "30m"`, `cancelOn:
[{event: "project/deleted", if: "async.data.projectId == event.data.projectId"}]`,
triggered on `repository/index.requested`, with an `onFailure` handler that writes
terminal state unconditionally. `IndexErrorCode` is now five values:
`REPO_NOT_FOUND | TARBALL_DOWNLOAD_FAILED | UNSAFE_ARCHIVE | REPO_TOO_LARGE |
ACCESS_REVOKED`, plus the message-parsing fallback `"UNKNOWN"` for anything uncoded.

**The API surface**: `GET /api/repositories/:id/index-status` → `{status,
currentStep, progressPercent, filesTotal, filesProcessed, error}` (exactly §7's six
fields); `POST /api/repositories/:id/index` → `202 {indexJobId}`, `400` on `mode:
"INCREMENTAL"` (schema-level, tested), `409` already indexing, `429` rate-limited
(`details.retryAfterSeconds` when known). `GET /api/repositories/:id`'s `indexJob` field
is now `IndexJobSummaryDto | null` (`{id, status, currentStep, progressPercent,
filesTotal, filesProcessed, filesSkipped, error}`). `apps/web/src/lib/api.ts`'s mirror
types (`Repository.indexError`, `RepositoryDetail.indexJob: IndexJobSummary | null`) are
widened and typecheck against the real shapes but have **zero consumers yet** — no
frontend code reads either field. Building the index-status card with live polling
(phase-03-repository-indexing.md §18/§29.2's `IndexStatusPoller`) is entirely Prompt 3's,
starting from a clean compile rather than a `null`-typed placeholder.

**What still needs real, live, end-to-end coverage** (§12's own list, restated as
concrete test targets): a synthetic-but-real ~1,000+-file tarball run all the way through
`indexRepository` and `repository-index.ts` together (not just each piece separately);
the interrupted-job-resumes-without-duplicates acceptance criterion (§14 of the phase
document) — the upsert's idempotency is proven at the persistence layer (§6) but never
exercised via an actually-killed-and-restarted worker process; the
`GithubRateLimitError`/sleep-loop path, live; `stale-index-sweeper`'s cron actually
firing and finding a genuinely stale row.

**A test-hygiene note, not a bug**: `repository-index.test.ts` and
`stale-index-sweeper.test.ts` both import modules that statically import
`repository.repository.ts` (and therefore `@repo/db`'s `prisma` singleton, which
requires `DATABASE_URL` at import time). The former happens to work without mocking that
import because it _also_ imports `config/env.ts` (for `env.WORKER_TEMP_DIR`), whose own
`import "dotenv/config"` side effect loads `.env` before `@repo/db` is ever evaluated —
incidental, load-order-dependent, and would break the moment that unrelated import were
removed. The latter mocks `repository.repository.ts` directly, which is the more robust
pattern. Worth normalizing one way explicitly in a future pass, flagged rather than
silently left as one working test relying on another file's unrelated import for its own
correctness.
