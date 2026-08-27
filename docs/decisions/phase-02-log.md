# Phase 02 — Decision Log

Records the judgment calls made implementing Phase 02 **Prompt 1** (foundation + GitHub
App client): the schema, the configuration, the Redis-backed token cache, and the GitHub
client. Prompts 2 and 3 build the services, routes, and UI on top of this; entries here
are binding for that work.

Same convention as `phase-00-log.md` / `phase-01-log.md`: this file records what was
decided _and_ what could not be verified from this environment. §12 is the honest list.

## 0. Inherited baseline (verified before writing any Phase 02 code)

Every command run against the tree as inherited, before a single line was changed:

| Command                 | Result                                                              |
| ----------------------- | ------------------------------------------------------------------- |
| `pnpm install`          | Clean — "Already up to date", 6 workspace projects                  |
| `pnpm db:generate`      | Prisma Client 7.9.1 generated to `packages/db/src/generated`        |
| `pnpm lint`             | Pass, 0 errors (`turbo lint` + the root boundary/no-console config) |
| `pnpm typecheck`        | Pass — 3 tasks (`api`, `web`, `worker`)                             |
| `pnpm test:unit`        | Pass — **10 files, 94 tests**                                       |
| `pnpm test:integration` | Pass — **6 files, 58 tests** (Testcontainers Postgres)              |
| `pnpm build`            | Pass — 3 tasks                                                      |
| `prisma migrate status` | "Database schema is up to date!", 2 migrations found                |

**Nothing was red**, so no pre-existing failure had to be reported before starting —
with one caveat that is not in the prompt's baseline list, recorded in §11.

Two facts about the inherited state differ from the prompt's description of it, and are
recorded rather than silently worked around:

- The prompt describes `main` as a single commit `a495021` merging `phase-01`. In this
  repository `main` is at `f9b9364` and the Phase 01 work has **not** been merged — it
  lives on the working branch, 10 commits ahead of `main`.
- The prompt says to start `git checkout -b phase-02`. The working branch was already
  `phase-02-git-repo-integration`, created for exactly this work and already carrying
  the unmerged Phase 01 history. Renaming it to `phase-02` would have been cosmetic
  churn on a branch that is already the Phase 02 branch, so the existing name was kept.
- Nothing in this environment auto-committed anything (`phase-01-log.md` §27 warns it
  once did). `git status` was checked before and after every sub-task; every commit
  below was made deliberately.

## 1. Installed versions — read, not assumed

Each of these was verified by reading the installed package's own source and type
definitions under `node_modules/`, per this repo's established practice
(`phase-01-log.md` §1). Where the behavior mattered, the specific file is named.

| Package                      | Version      | Why this one                                                                                                                                                                                                                  |
| ---------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ioredis`                    | 6.0.0        | The installation-token cache client — see §6 for the choice against `redis`                                                                                                                                                   |
| `@octokit/auth-app`          | 8.3.0        | App JWT signing. Preferred over hand-rolling RS256, per the prompt                                                                                                                                                            |
| `@octokit/core`              | 7.0.7        | The Octokit base the plugins target. `octokit` (the batteries-included meta-package) would have pulled `plugin-rest-endpoint-methods`, `plugin-paginate-rest`, and the GraphQL client for a client that makes four REST calls |
| `@octokit/plugin-retry`      | 8.1.1        | 5xx/network retry. Peer-requires `@octokit/core` ^7                                                                                                                                                                           |
| `@octokit/plugin-throttling` | 11.0.5       | Primary + secondary rate limits                                                                                                                                                                                               |
| `@octokit/request-error`     | 7.1.1        | Direct dependency so error narrowing does not rely on a transitive install                                                                                                                                                    |
| `@octokit/types`             | 15.0.2 (dev) | `EndpointDefaults` etc. for the handler signatures. Dev-only: types erase at build                                                                                                                                            |

Transitively relevant, verified because their behavior is load-bearing here:

| Package                    | Version | What was verified                                                                                                                                                                                                                                             |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `universal-github-app-jwt` | 2.2.2   | `auth-app`'s signer. Backdates `iat` by 30s, sets `exp` to iat+10min (GitHub's maximum), and — in `lib/crypto-node.js` — converts a **PKCS#1** key to PKCS#8 before handing it to WebCrypto. That is why the config accepts GitHub's default `.pem` unchanged |
| `@octokit/request`         | 10.0.15 | `fetch-wrapper.js` **throws** a `RequestError` on `304` rather than returning one. The ETag plugin is built around that fact (§9)                                                                                                                             |
| `before-after-hook`        | 4.0.0   | `register.js`'s reduce applies registered wraps outward-in: the **last** registered wrap is outermost. Plugin order in `octokit-factory.ts` depends on this                                                                                                   |
| `bottleneck`               | 2.19.5  | Pulled by `plugin-throttling`. Its `light.js` build, no Redis clustering configured                                                                                                                                                                           |

Two API facts worth writing down because getting them from memory would have been wrong:

- **`@octokit/plugin-throttling` throws at construction** unless _both_ `onRateLimit` and
  `onSecondaryRateLimit` are functions (`dist-src/index.js`). They are not optional.
- **`ioredis@6` has no default export usable from ESM.** `import Redis from "ioredis"`
  type-checks as a namespace and is not constructable under `NodeNext`; the named
  `import { Redis } from "ioredis"` is correct. Verified both at the type level and by
  running it under Node 22.

## 2. Private-key encoding — base64, checked at boot

`GITHUB_APP_PRIVATE_KEY` is **base64 of the whole `.pem` file**. One line, no escaping
rules, survives every `.env` loader and secret store unchanged. `config.ts` decodes it
and refuses to boot unless the result carries a `-----BEGIN [RSA ]PRIVATE KEY-----`
header _and_ a matching footer.

Chosen over literal `\n` escapes because escape handling is where this actually breaks in
practice: a value can survive one env loader and be mangled by the next, and the failure
then surfaces at the first GitHub call rather than at boot.

A value that already looks like a PEM is passed through unchanged. dotenv supports
multi-line double-quoted values, so pasting the file works locally, and rejecting it
would be hostile for no security gain. This is a local-dev convenience, not a second
supported deployment encoding — `docs/github-app-setup.md` documents base64 as _the_
encoding.

`loadConfig`'s error message was widened to carry each field's first Zod message, not
just the variable name. Without that, a mangled key reported identically to a missing
one ("missing/invalid variable(s): GITHUB_APP_PRIVATE_KEY"), which is the least useful
half of what the validator already knew.

**`REDIS_URL` is validated more strictly than "must parse as a URL."** `new
URL("localhost:6379")` parses happily — scheme `localhost:` — so `z.url()` alone would
pass the single most likely typo straight through to a connect-time failure. The scheme
is pinned to `redis://`, `rediss://`, or `unix://`.

## 3. `GITHUB_PRIVATE_KEY` → `GITHUB_APP_PRIVATE_KEY`

`.env.example`'s "Reserved for later phases" block carried `GITHUB_PRIVATE_KEY`.
phase-02 §19 specifies `GITHUB_APP_PRIVATE_KEY`. **The phase document wins** and the
variable was renamed.

Beyond following the spec, the longer name is the better one here: `APP` is exactly the
distinction this phase exists to keep visible, and `GITHUB_PRIVATE_KEY` sitting three
lines from `GITHUB_OAUTH_CLIENT_SECRET` invites precisely the conflation `plan.md` §45
warns about. `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `REDIS_URL` were promoted out
of the reserved block into a commented "Phase 02" section; `GITHUB_APP_SLUG` and
`GITHUB_APP_WEBHOOK_SECRET` were added. The reserved block retains a note saying where
the old name went, so nobody has to `git log -S` for it.

No code anywhere referenced the old name — it was a placeholder, never wired up.

## 4. Schema — the four conflicts between phase-02 §6 and `plan.md` §24.2

**`htmlUrl` — added.** §6's Prisma block omits it, but §6's own §4 Data Requirements
lists it as required GitHub identity, and `plan.md` §24.2 has it. §6's stated rationale
for declaring later-phase fields early — "avoids a schema-churning migration
mid-indexing-buildout" — applies with more force to a field the same document calls
required. Added as `String` (non-null): it is always present on the very
`GET /repos/{o}/{r}` response the connect flow already reads.

**`sizeBytes Int?` and `webhookId BigInt?` — both added, nullable.** In `plan.md` §24.2,
absent from §6. Same "declare early" rationale, plus specifics: `sizeBytes` comes from
the identical metadata call this phase already makes for the size cap, so _not_ storing
it would mean re-fetching to answer "how big is this repo?"; and Phase 06 needs
`webhookId` to manage the webhook it registers. Nullable because Prompt 1 writes neither
and a non-null column would force a fabricated default.

_(Note: `sizeBytes` maps to Postgres `INTEGER`. GitHub reports repository size in KB, and
the connect-time cap is ~500 MB, so int32 has roughly six orders of magnitude of
headroom. The column name says bytes and the source is KB — whichever unit Prompt 2
stores, it must be consistent, and this note exists so that choice is made deliberately.)_

**`installationId` stays a plain `BigInt`, not a foreign key.** `plan.md` §24.2 calls it
a `fk`, and a real relation _is_ possible — `GithubInstallation.installationId` already
carries `@unique`. §6 specifies a plain `BigInt` and that is what was built, deliberately:

- A real FK with `onDelete: Cascade` would delete every `Repository` row the moment a
  user uninstalls the App. That is the exact scenario `connectionStatus = ACCESS_LOST`
  exists to represent (§11) — a repository that is still connected, still owned, still
  has an index, but is temporarily unreachable. Cascading it away destroys connection
  history and makes reinstall-and-recover impossible.
- `onDelete: SetNull`/`Restrict` would avoid the deletion but make the column nullable or
  make uninstall fail — both worse than a plain column.
- What is given up is referential integrity: nothing at the database level stops a
  `Repository` pointing at an installation row that no longer exists. That is acceptable
  precisely because "the installation is gone" is a state this model must be able to
  represent, not an inconsistency to prevent.

**No standalone `@@index([projectId])`.** `plan.md` §24.2 lists one; §6 does not. §6 is
followed, because `@@unique([projectId, githubRepoId])` already creates a
`projectId`-prefixed composite B-tree index, which Postgres uses for `WHERE projectId = ?`
exactly as a single-column index would. A second index would be pure write amplification.
`db.test.ts` asserts the index is _absent_, so the omission reads as a decision rather
than an oversight.

## 5. `connectionStatus` is a String, `indexStatus` is an enum

The asymmetry is in both source documents and was followed rather than "corrected" —
changing it would mean diverging from every downstream phase document that reads these
columns.

But a `String` column accepts anything, so the three legal values are pinned as a
TypeScript union in `apps/api/src/modules/repositories/repository.types.ts`
(`CONNECTION_STATUSES`, `ConnectionStatus`, `isConnectionStatus`). Every write from the
API layer goes through it, so the type-safety the enum would have given is recovered
above the database even though the constraint is not enforced below it.

If this is ever revisited, the argument _for_ an enum is that `ACCESS_LOST` is a state
Phase 03+ transitions into automatically, and a typo in a background job would silently
write a status nothing matches. The argument against is a migration touching a table
that by then holds real rows. Not this phase's call.

## 6. Redis client: `ioredis@6`, not `redis@6`

Both are current and maintained. `ioredis` was chosen because:

- **One package, bundled types.** `redis@6.2.1` depends on `@redis/client` plus
  `@redis/json`, `@redis/bloom`, `@redis/search`, and `@redis/time-series` — four modules
  for capabilities a token cache will never use.
- **`lazyConnect` is a first-class option**, which is exactly what sub-task 1.3 requires:
  importing the module must not open a socket.
- Its `set(key, value, "EX", seconds)` signature maps 1:1 onto the `TokenCache` interface
  with no adapter. Verified as a real overload in
  `built/utils/RedisCommander.d.ts:3300`, not assumed.

Connection options, all chosen against the installed `RedisOptions` type and all
deliberate: `lazyConnect` (no dial at import), `connectTimeout: 5000` (a hung connect must
not hang a request), `maxRetriesPerRequest: 1` and `enableOfflineQueue: false` — ioredis's
defaults retry commands across reconnects and queue them while disconnected, which is
right for a datastore and wrong for a cache. A caller would rather take a miss and mint a
token than wait. An `error` listener is registered because an ioredis client without one
crashes the process on an unhandled `error` event.

## 7. `TokenCache` as an interface, not direct Redis calls

Follows the existing pattern of putting an abstraction in front of an infrastructure
choice made for MVP pragmatism (the `VectorStore`-over-pgvector precedent). The immediate
payoff is concrete rather than architectural: the expiry-boundary tests §22 requires are
in the **unit** suite, with an injected fake clock and no I/O, which is only possible
because the cache is an interface with an in-memory implementation.

The interface is deliberately ignorant of GitHub — opaque string values, TTL in seconds.
`app-auth.ts` owns every token-specific rule. That is also what let the same interface be
reused for the ETag store (§9) without changing a line of it.

## 8. Redis unavailable → warn once per window, fall through to memory

**Decision:** a Redis error is logged at `warn` at most once per 60 seconds and then falls
through to a process-local in-memory cache. It never fails the caller.

phase-02 §4 sanctions the fallback outright ("tokens live only in the Redis cache (or
in-memory)"). The asymmetry decides it: the worst case of a cache miss is **one extra
JWT→token exchange** against GitHub, which costs a few hundred milliseconds and one
request out of 5,000/hr. The worst case of failing hard is that a Redis outage becomes a
total outage of every GitHub-touching path in the product. Those are not close.

**The rate limit on the warning is not cosmetic.** Redis is consulted on every GitHub
call. Without suppression, a Redis outage emits a log line per request — which is how a
cache incident becomes a logging incident, and how the one line that explains the outage
gets buried under ten thousand copies of itself.

Costs of the fallback, accepted knowingly:

- Tokens stop being shared across replicas, so each replica mints its own. With a
  50-minute TTL that is at most ~1 mint per replica per installation per hour.
- The in-memory cache dies with the process. Same bound.
- `delete()` clears the in-memory copy **first**, so an explicit invalidation is never
  defeated by a stale local copy written during an outage.
- `get()` consults the fallback on a Redis _miss_ too, so a write made during an outage
  is still readable after Redis recovers.

## 9. ETag cache — hand-rolled, because no maintained plugin exists

The registry was checked before writing anything: `octokit-plugin-etag-cache`,
`@octokit/plugin-etag-cache`, `octokit-plugin-cache`, and `@gr2m/octokit-plugin-cache`
all return 404. There is nothing credible to depend on, so `etag-cache.ts` is ~80 lines
on Octokit's own public `hook.wrap("request", …)` API — a supported extension point, not
a private one.

Three decisions inside it:

**Cache keys are scoped by installation.** `gh:etag:{installationId}:{METHOD}:{url}`. Two
installations can receive different bodies for the same URL — one may see a private
repository the other cannot — so an unscoped key would let one tenant's installation
serve another's cached response. That is a data-leak bug, not a cache-tuning detail, and
`octokit-factory.test.ts` asserts the isolation directly.

**The plugin is registered FIRST, so its wrap is innermost.** `@octokit/request` throws
on `304` rather than returning it (verified above), so the throw has to be converted back
into a success _before_ the retry plugin's error hook sees it. Registered outermost,
every cache hit would have been retried as a failure. `304` is additionally added to the
retry plugin's `doNotRetry` list — belt and braces, so a future reordering degrades to
"no caching" rather than to "silently retries every cache hit."

**A cache hit is returned as a `200`, not a `304`.** No call site should have to know
caching exists. (`retryCount: 0` is set on the synthesized response because
`plugin-throttling` augments `OctokitResponse` to require it — the compiler caught this,
which is a small argument for reading the installed types rather than the docs.)

TTL is 24h. An ETag never semantically expires, but unbounded cache growth is real, and a
dropped entry costs one full response.

## 10. Rule A did need extending

**It did not hold.** Rule A's patterns named `@repo/ai`, `@repo/github`, and
`@repo/embedings` — package specifiers. Phase 02 put the GitHub client inside `apps/api`
itself (`apps/api/src/github/**`, per the path mapping in `phase-00-log.md` §1), so a
controller importing `../github/client/octokit-factory.js` would have matched nothing.
The rule would have silently stopped covering the exact thing it was written to cover.

`eslint.config.mjs`'s Rule A gained a second pattern group
(`**/src/github/**`, `**/github/client/*`, `**/github/services/*`) with its own message,
plus a fixture at `apps/api/tests/fixtures/lint/rule-a-github-tree-violation.ts` and an
assertion in `boundaries.test.ts` proving it fires. Module services under
`apps/api/src/modules/**` are deliberately _not_ in Rule A's `files` list, so they may
still import the client — which is the point: routes and controllers delegate, services
do the work.

## 11. Redaction was insufficient, and was fixed

`logger.ts` redacted `DATABASE_URL` plus any key ending in `_KEY`, `_SECRET`, or
`_TOKEN`. Those patterns only ever matched **environment-variable names**. A field
literally named `token`, or `accessToken`, or `privateKey` — precisely the names this
phase's code puts near a logger — would have gone straight to stdout.

phase-02 §13 requires that installation tokens are "never logged", and §15 makes it an
acceptance criterion. So this was fixed, not documented as a caveat: `shouldRedactKey`
now also normalizes the key (lowercase, separators stripped) and matches an exact set
(`authorization`, `cookie`, `setcookie`, `credentials`, `pem`) plus the suffixes `token`,
`secret`, `password`, `passphrase`, `privatekey`, `apikey`.

**A bare `key` is deliberately NOT redacted.** The token cache logs its _cache key_ by
design — it is a diagnostic derived from an installation id, not a secret — and
redacting it would remove the only field that makes a cache log line useful.
`apiKey`/`privateKey` are matched explicitly rather than by a blanket `*key` suffix.

Two layers of assertion back this up, because a redaction list is exactly the kind of
thing that silently rots: `logger.test.ts` checks the key patterns directly, and
`app-auth.test.ts` asserts that the token string appears in **no** emitted log line
across the success path, the cache-hit path, and all three failure paths.

## 12. Token minting — the decisions inside `app-auth.ts`

**JWT from `@octokit/auth-app`, exchange done here.** The App JWT is delegated (the
prompt prefers it, and RS256 signing is not worth hand-rolling). The installation-token
_exchange_ is not, even though `auth-app` offers it — because `auth-app` keeps its own
in-memory LRU of installation tokens with its own expiry rules. That cache would sit
underneath this module's Redis cache and quietly own the very expiry boundary §22
requires us to test. Two caches with two expiry policies, one of them invisible, is how
an off-by-one survives its own regression test.

**TTL is `min(50 minutes, expires_at − now − 60s)`.** Trusting GitHub's stated
`expires_at` over local "it's always 60 minutes" arithmetic is strictly safer: if this
host's clock runs behind GitHub's, a token assumed good for 50 more minutes may already
be dead. `TOKEN_CACHE_TTL_SECONDS` is exported so the boundary test references the same
value the production path uses.

That alone would let someone widen the margin to 60 minutes and still see green, so
`app-auth.test.ts` _additionally_ pins the constant's value and asserts it leaves ≥10
minutes of headroom under GitHub's hour. Temporarily setting it to `60 * 60` was run and
fails 4 tests — the check the prompt asks for.

**Retry taxonomy** (phase-02 §12), all asserted:

- 5xx or network error → 3 attempts total, backoff 250ms then 500ms, then a clean
  `ServiceUnavailableError`. Never hangs.
- **401 → no retry**, `GithubAccessRevokedError`. A revoked installation does not become
  un-revoked by asking again.
- **403/429 _with_ rate-limit headers → `GithubRateLimitError`**, never revocation.
  Getting this backwards would mark healthy repositories `ACCESS_LOST` every time the App
  got busy.
- 403/404 _without_ rate-limit headers → suspended or gone → `GithubAccessRevokedError`.
- Any other 4xx → no retry (a request we got wrong does not improve on repetition).
- A 2xx with no `token` field → `ServiceUnavailableError`, not revocation: it means we do
  not understand the response, which is a bug rather than a permission state.

**Two new `AppError` subclasses**, in `lib/errors.ts` beside the others (so Prompt 2's
service layer imports them without reaching into the GitHub tree, which Rule A now
guards). `GithubAccessRevokedError` is 403; `GithubRateLimitError` is **503, not 429** —
the exhausted budget is _ours_ against GitHub, not the caller's against this API, so
"you are sending too many requests" would be a false statement to the user.
`details.retryAfterSeconds` carries the wait.

**A rate-limited _mint_ fails fast rather than sleeping.** GitHub's primary limit resets
on a fixed hourly window, so `x-ratelimit-reset` can be an hour out. Sleeping that long
inside a user-facing request holds the connection open for nothing. Ordinary API calls go
through `octokit-factory`, which _does_ schedule short waits — capped at
`MAX_RATE_LIMIT_WAIT_SECONDS` (30s) for the same reason.

**Octokit authenticates per request, not per instance.** `octokit-factory` installs a
`hook.before("request")` that resolves the token from `app-auth` on every call rather
than `new Octokit({ auth: token })`. A client built the second way bakes in a token that
silently rots; built this way, a client held across the 50-minute boundary picks up the
fresh token automatically. Costs nothing — the resolve is a cache read.

## 13. Repo quirks encountered (not fixed — noted, per the prompt)

- **`.github/workflow/ci.yml`** is in a directory GitHub does not read (`workflow`, not
  `workflows`) and is entirely commented out. **CI is not running.** The five new Phase 02
  variables were added to its commented `env:` block with dummy values so the block stays
  accurate, and the "never echo these" comment was left intact. Neither the directory
  name nor the commenting was changed. _This means nothing in this phase has been
  verified by CI — only locally._
- **`pnpm format:check` fails, and failed before this phase started.** 147 files were
  already unformatted at the inherited baseline; this phase's files bring it to ~152. The
  cause is a config conflict: `prettier.config.js` (`printWidth: 100`) uses
  `module.exports` in a `"type": "module"` package, so **it throws if Prettier ever loads
  it** — `.prettierrc` (no `printWidth`, so the 80-column default) is what actually
  applies, while the codebase is written to ~100+. Running `pnpm format` would reformat
  the entire repository against a config nobody intended, which is a far larger and
  riskier diff than this phase. New files match the style of their neighbours instead.
  **Recommended fix, deliberately not done here:** rename `prettier.config.js` to
  `prettier.config.cjs` (or fold `printWidth: 100` into `.prettierrc` and delete it),
  then run `pnpm format` as a single isolated commit.
- **`packages/db/.env` points at a live Neon database.** Every Prisma command run during
  this work explicitly overrode `DATABASE_URL` to the local docker-compose Postgres.
  Unchanged from `phase-00-log.md` §12 and still a live foot-gun: a bare
  `pnpm db:migrate` from the repo root will target Neon.
- `apps/web/` still carries its own nested `pnpm-lock.yaml`/`pnpm-workspace.yaml`, and
  `apps/api/index.js` still looks vestigial. Neither got in the way; neither was touched.

## 14. Outstanding — requires human action

Blunt list, in the spirit of `phase-01-log.md` §13/§28. None of the following has been
done, and none of it _can_ be done from this environment:

- [ ] **No real GitHub App has been registered.** `docs/github-app-setup.md` is a runbook
      written against GitHub's documented registration flow; nobody has walked it.
- [ ] **No real installation exists**, so no installation token has ever been minted
      against GitHub. Every token in every test is a fake string from a stubbed HTTP
      layer. The JWT-signing path has never run against a real RSA private key.
- [ ] **No repository has been connected end to end** — the routes and UI that would make
      that possible are Prompts 2 and 3 of this phase.
- [ ] **No staging verification.** No staging environment exists (still outstanding from
      Phase 00, see `docs/deployment.md`). Redis has not been provisioned anywhere but
      locally.
- [ ] **The webhook path is entirely unexercised.** `GITHUB_APP_WEBHOOK_SECRET` is
      validated at boot and read by nothing. Phase 06 is the first code that touches it.
- [ ] **The `ACCESS_LOST` transition has not been observed**, only the typed error that
      should trigger it. Actually revoking an installation and watching a repository move
      to `ACCESS_LOST` needs Prompt 2's service layer plus Phase 03's background work.
- [ ] **The ETag `304` path has never seen a real GitHub `304`** — only a stubbed one.
      GitHub's real ETag/`If-None-Match` behavior for these endpoints is assumed to match
      the HTTP spec.
- [ ] **CI has never run any of this** (see §13).

What _has_ been verified against something real: Redis (the `RedisTokenCache` was
exercised against the live `redis:7-alpine` container — set with EX, read back, TTL
confirmed at 5s, delete), Postgres (the migration and every `Repository` schema assertion
ran against a real database), and the boot path (`apps/api` starts with the documented
values and answers `GET /api/health` with 200; it refuses to start, naming the variable,
when a Phase 02 variable is missing or the private key is mangled).

## 15. Commits in this prompt

| Commit    | Sub-task                                              |
| --------- | ----------------------------------------------------- |
| `cc153d6` | Redis service, GitHub App env vars, config validation |
| `6f0242e` | `Repository` model, `IndexStatus` enum, migration     |
| `0df5035` | `TokenCache` abstraction, Redis + in-memory backends  |
| `967929d` | `app-auth` token minting with caching and retry       |
| `59b3f03` | Octokit factory: retry, rate limiting, ETag caching   |
| `278c6ab` | GitHub App registration + permission rationale docs   |

The expiry-boundary tests §22 asks for by name ship with `967929d` rather than in a
separate commit — they test `app-auth.ts` and belong beside it; splitting them out would
have meant committing that sub-task with its own named failure point untested.

## 16. What Prompt 2 inherits

- `getInstallationToken(installationId: bigint): Promise<string>` — the whole GitHub
  credential surface. Callers never see the JWT, the cache, or the private key.
- `createInstallationOctokit(installationId, options?)` — the only sanctioned way to
  build an Octokit. Do not construct one anywhere else.
- `GithubAccessRevokedError` / `GithubRateLimitError` — map the first to
  `connectionStatus = ACCESS_LOST`, never the second.
- `CONNECTION_STATUSES` / `ConnectionStatus` in
  `apps/api/src/modules/repositories/repository.types.ts`.
- **BigInt stops being theoretical.** `installationId` and `githubRepoId` are real bigints
  and `JSON.stringify` throws on them. Convert to `string` explicitly at the DTO
  boundary, per `phase-01-log.md` §4 — `project.types.ts`'s hand-written mapping exists
  precisely so this is a deliberate act.
- **There is still no 422 error class.** Prompt 2's sub-task 2.5 adds it.
- Rule A now also blocks routes/controllers from importing `apps/api/src/github/**`
  directly. Go through a module service.

---

# Phase 02 — Prompt 2 (backend services, tenancy, API)

Records the judgment calls made implementing **Prompt 2**: the module services, the
tenancy extension, the routes, and the event contract. Prompt 1's entries above are
binding for this work; entries here are binding for Prompt 3.

## 17. Inherited baseline (verified before writing any Prompt 2 code)

Every command run against the tree as inherited from Prompt 1, before a line was
changed:

| Command                 | Result                                                       |
| ----------------------- | ------------------------------------------------------------ |
| `pnpm install`          | Clean — "Already up to date", 6 workspace projects           |
| `pnpm db:generate`      | Prisma Client 7.9.1 generated to `packages/db/src/generated` |
| `pnpm lint`             | Pass, 0 errors                                               |
| `pnpm typecheck`        | Pass — 3 tasks (`api`, `web`, `worker`)                      |
| `pnpm test:unit`        | Pass — **13 files, 170 tests**                               |
| `pnpm test:integration` | Pass — **6 files, 65 tests** (Testcontainers Postgres)       |
| `pnpm build`            | Pass — 3 tasks                                               |
| `prisma migrate status` | "Database schema is up to date!", **3 migrations** found     |

`Repository` and `IndexStatus` are present in the generated client
(`packages/db/src/generated/models/Repository`, `enums.ts`), and
`apps/api/src/github/client/` contains `app-auth.ts`, `octokit-factory.ts`,
`token-cache.ts`, `etag-cache.ts`, `rate-limiter.ts`, and `redis.ts`. **Nothing was
red.**

One correction to §0's numbers above, worth noting because the decision log is the
place these are supposed to be accurate: §0 records the pre-Phase-02 integration suite
as "6 files, 58 tests". It is 65 as of Prompt 1's final commit — Prompt 1's own
`db.test.ts` additions account for the difference.

`prisma migrate status` must be run with `DATABASE_URL` overridden to the local
docker-compose Postgres (`postgresql://postgres:postgres@localhost:5432/dev`, the
`POSTGRES_DB: dev` from docker-compose.yml). `packages/db/.env` still points at a live
Neon database — §13's foot-gun, unchanged and still live.

## 18. 403 vs 404 — re-opened by phase-02 §7, and the answer did not change

phase-02 §7 lists **403** as a possible error for `GET`/`DELETE /api/repositories/:id`.
phase-01-log §16 had already settled — deliberately — that a foreign resource returns
**404**, because a 403 is an enumeration oracle. These conflict. The resolution, now
written into `tenant-access.ts`'s doc comment so it survives:

**Tenancy failures stay 404.** A repository that is missing, foreign, mismatched, or
under a soft-deleted project → `404 NOT_FOUND`, with the message `"Project not found"`
— not `"Repository not found"`, because even naming the resource type confirms that the
id names a repository. The distinction survives only in the `warn` log line
(`MISSING` | `FOREIGN` | `DELETED` | `MISMATCH`).

**403 is reserved for the genuinely different case in §12**: the caller _provably owns
the project_ and is being told the **GitHub App** cannot reach the repository they
named. That is not a leak — the user supplied the repository themselves, by typing its
URL or picking it out of their own installation's list — and it is the only actionable
answer ("check your installation settings"). It is raised by
`repository-validation.service`, never by the tenancy check. This is exactly what
`ForbiddenError`'s existing doc comment in `errors.ts` reserved it for.

`MISMATCH` is a new `DenialReason`: the caller named both a `projectId` and a
`repositoryId` and they disagree. It is a denial rather than a silent preference for
one — trusting the repository's own `projectId` would let a handler operate on a project
the request did not name.

## 19. The installation-403 exception (sub-task 2.8)

`GET /api/github/installations/:id/repos` answers **403** for an installation the caller
does not own, per §7. That looks like an inconsistency with §18 and is not. The
reasoning, also written into `github.controller.ts`:

- An installation id is a **GitHub-global integer the user can already read on
  github.com** — it is in the URL of their own installation settings page and in the
  install-flow redirect. Confirming that an id names an installation reveals nothing
  GitHub does not reveal directly.
- It is **not this system's identifier**. There is no per-tenant id space to enumerate;
  the ids exist whether or not this product ever saw them.
- What is actually protected — the _repository names_ the installation can see — stays
  protected: the listing is only ever fetched for an installation the caller owns, and
  that check is server-side (`GithubInstallation.userId`), never trusted from client
  input (§13).

A project id has none of those properties, which is why the two answers differ.

## 20. The emit-await decision

`emitRepositoryIndexRequested` **keeps Phase 01's fire-and-forget pattern**, and this
was re-argued rather than copied — `emitProjectDeleted`'s reasoning ("a notification
nobody consumes, measured at 5.3s of SDK backoff on a bad key") does not transfer
automatically, because from Phase 03 onward this event is the _only_ indexing trigger
and a dropped one means a repository sits in `PENDING` forever.

Kept anyway, on three grounds:

1. **Nothing consumes it yet** (§8), so a dropped event costs exactly nothing today,
   while awaiting would put Inngest's availability in the latency path of a mutation
   §7 already specifies as `202 Accepted`.
2. **The durable record is the row, not the event.** The `Repository` row is committed
   in `PENDING` before the emit. That is a state Phase 03 can reconcile from directly
   ("find `PENDING` repositories with no job and enqueue one"), which is the correct
   lost-event recovery regardless of what this function does.
3. **Awaiting would be a false guarantee.** A successful `send()` means Inngest accepted
   the event, not that a function ran. Only a transactional outbox makes delivery
   reliable — which `emitProjectDeleted`'s own comment already flags — and a half-measure
   that _looks_ like a guarantee is worse than an honest absence of one.

What changed from the Phase 01 pattern: the failure is logged at **`error`** with both
`repositoryId` and `projectId` (§20 requires both on this path), and there is an
explicit `TODO(phase-03)` naming the outbox-plus-reconcile fix.

## 21. The noop function stays; the deletion moves to Phase 03

`apps/worker/src/inngest/functions/noop.ts` said to delete it "once Phase 02 introduces
the first real event". Phase 02 introduces the _event_ but §8 is explicit that no
function consumes it until Phase 03.

Deleting it now would leave the worker with **zero registered functions** — which
changes what the Inngest Dev Server displays and removes the only end-to-end proof the
worker is discoverable at all, at exactly the moment this phase's acceptance signal
(§8) is "look at the Dev Server UI". Kept, with its comment updated to say the deletion
is Phase 03's, when `repository-index` proves the same things better.

## 22. The size cap — unit VERIFIED, not assumed

`plan.md` A7 states the limit as "~25k source files / ~500 MB checkout". GitHub's `size`
field on `GET /repos` had to be pinned down before it could be compared against that.

**Verified empirically against live `api.github.com`** on 2026-08-24, rather than from
memory or from the docs (the REST reference page carries no description text for the
field at all):

```
GET https://api.github.com/repos/torvalds/linux  →  "size": 6350863
```

6,350,863 is ~6.06 GiB, which matches that project's packed git objects. It is
inconsistent with bytes (6.3 MB) and with MB (6.3 TB). **The unit is KiB, and it is the
_git_ size — history included — not a working-tree checkout.**

Consequences, both recorded in the constant's own doc comment:

- `REPOSITORY_SIZE_CAP_KIB = 500 * 1024` (500 MiB). The metadata field is named
  `sizeKib` end-to-end so no comparison can quietly treat it as bytes.
- A repository's git size is normally **larger** than its checkout, so capping git size
  at 500 MiB is **conservative** against A7's "checkout" wording — it declines some
  repositories whose working tree would fit. That is the right direction to err for an
  MVP: accepting a repository the indexer then chokes on is worse than declining one at
  the door with a clear message.
- **A7's file-count half (~25k files) is not checkable from this call at all.**
  `GET /repos` reports no file count. Phase 03, which walks the tree, is the first code
  that can enforce it. Nothing in this phase pretends to.

**The `sizeBytes` column stores bytes.** §4 above flagged that the column name says
bytes while the source is KB, and said Prompt 2 had to choose deliberately. It does:
`repository.service` multiplies by 1024 at the single place a size is written, so the
column matches its own name. int32 holds 2 GiB, and nothing over 500 MiB is ever
stored, so overflow is unreachable.

## 23. Empty-repository detection — combined signals, and one extra call only when ambiguous

`size: 0` is the documented signal and is **unreliable alone**: GitHub computes
repository size asynchronously, so a repository pushed moments ago reports `0` while
holding real commits. Rejecting on it would tell a user who just created and pushed a
repository that it is empty.

The chosen combination:

| Signal                                            | Conclusion                                                                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sizeKib > 0`                                     | Has content. No probe, no extra call.                                                                                                                    |
| `sizeKib === 0` **and** no default branch         | Unambiguously empty. No probe.                                                                                                                           |
| `sizeKib === 0` **but** a default branch is named | **Ambiguous** — probe `GET /repos/{o}/{r}/branches/{default}`. A `404` on the ref, from a repository whose metadata just read successfully, means empty. |
| Probe returns `UNKNOWN` (5xx)                     | Treated as **not empty**.                                                                                                                                |

The `UNKNOWN` policy is deliberate and is the "do not reject a legitimate small repo"
rule made concrete: a transient GitHub blip must not become "your repository is empty".
Being wrong that way costs Phase 03's indexer finding nothing and reporting it, which is
recoverable; being wrong the other way blocks a good repository, which is not.

The probe is **off the happy path** — any repository with content never triggers it —
so §21's rate-limit budget is untouched for every ordinary connect. §21's "one
`GET /repos` per connect attempt" is preserved and is enforced _structurally_:
`repository-validation.service` receives the already-fetched metadata and imports no
Octokit, no factory, and no fetching function, so re-fetching per sub-check is not a
mistake that can be made there.

**Step 6 is kept distinct from step 4.** A repository with content but no resolvable
default branch gets its own 422 and its own message, per §3's explicit instruction that
it not be folded into "empty".

## 24. `POST /api/projects/:id/repositories` — the mounting decision

Mounted as a **nested router**: `projectRepositoriesRouter` is created in
`repositories.routes.ts` with `Router({ mergeParams: true })` and mounted from
`projects.routes.ts` at `/:projectId/repositories`.

The alternative — registering the full `/projects/:projectId/repositories` path from
`repositories.routes.ts` — would put a `/projects/...` path in a file mounted at
`/repositories`, so the URL a reader sees in the file would not be the URL the server
serves. Nesting keeps the handler with its module and the URL shape with its parent.

**`mergeParams: true` is load-bearing.** Express does not propagate a parent router's
params into a child router by default: without it `req.params.projectId` is silently
`undefined` — not an error, just a tenancy check resolved against nothing.
`repositories.routes.test.ts` asserts the projectId actually arrives, so dropping the
flag fails a test rather than shipping.

## 25. Resolving _which installation_ to connect through — an under-specification in §7

§7's request body is `{ repoUrl?, githubRepoId? }` and carries **no installation id**,
yet every repository call needs one. §13 forbids deriving it from anything the client
submitted, so it is derived from the user's own `GithubInstallation` rows:

- **URL path**: a GitHub App installation is _per account_, and the URL's owner segment
  names that account — so the installation whose `accountLogin` matches (case-insensitively,
  because GitHub account names are) is the only one that could have access. One lookup,
  no GitHub calls.
- **Id path**: a repository id carries no owner, so the user's installations are searched
  in turn until one lists it. This is the only part of the connect flow costing more than
  a constant number of calls. ETag caching makes repeat listings free against the
  rate-limit budget, and users have one or two installations in practice.

**This is worth fixing in a later revision of §7**: the picker already knows the
installation id — it just called `GET /api/github/installations/:id/repos` — so putting
`installationId` in the connect body would turn the id path into a single lookup and
remove the only unbounded call in the flow. Not changed here, because the request
contract is the phase document's to set.

No matching installation is a **403 with the installation-settings message**, the same
answer as "the App can't see this repo" — from the user's side it is the same problem
with the same fix.

## 26. Smaller decisions, recorded so they are not re-litigated

- **`createUserOctokit`** was added to `octokit-factory.ts` rather than constructing a
  bare Octokit inside a service. §16's "do not construct one anywhere else" holds; the
  factory now has two constructors named for their credential, side by side, which is
  the clearest possible statement of the App-vs-OAuth distinction `plan.md` §45 names as
  a failure point. It gets retry + throttling + logging but **no ETag cache**: that cache
  is keyed by installation so one tenant can never serve another's body, and there is no
  installation here to key on.
- **`createRateLimitPolicy` and the logging plugin now accept `installationId: null`**
  for that one user-authenticated call. The field is still emitted, as an explicit
  `null`, so a log query filtering on `installationId` sees a value rather than a
  missing key.
- **`GithubFailureReason.NOT_ACCESSIBLE` is one reason, not two.** §12: GitHub returns
  `404`, not `403`, for a repository an installation cannot see — an anti-enumeration
  measure that makes "does not exist" and "you cannot see it" indistinguishable on the
  wire. Splitting them here would mean inventing a distinction the wire does not carry.
  The wrapper reports what it knows; the service decides what to tell the user.
- **A `403` _with_ rate-limit headers is `UNAVAILABLE`, never a permission answer.**
  Telling a user to reconfigure a working installation because GitHub was busy sends
  them to fix something that is not broken.
- **`installation.repository.ts` is a sibling file, not more functions in
  `repository.repository.ts`.** An installation is a different aggregate: it belongs to a
  user, not a project, and its lifecycle is owned by GitHub's install flow (and from
  Phase 06, by webhooks).
- **`upsertInstallation` writes `userId` in the `update` block too.** An installation id
  is GitHub-global, so the row re-attributes to whoever most recently proved — through
  their own OAuth token — that they can see it. Both members of an org legitimately can;
  a stale attribution would deny access to someone GitHub says yes for.
- **`findGithubAccessToken` pins `provider: "github"`.** This token is about to be sent
  to github.com; sending a different provider's token there would be a credential leak,
  not a failed request.
- **`syncInstallations` answers 401, not 503, for a missing or rejected OAuth token.**
  Signing in again is exactly what fixes it, and the frontend already redirects on 401.
- **`listByProject` excludes `DISCONNECTED` but includes `ACCESS_LOST`.** An
  `ACCESS_LOST` repository is still connected and still the user's; hiding it would
  remove the only place they could see the problem.
- **`DELETE /api/repositories/:id` does not use `allowDeleted`.** Idempotency is achieved
  at the row level — the repository row is never soft-deleted, only transitioned to
  `DISCONNECTED`, so it keeps resolving and `markDisconnected` reports 0 rows changed on
  a repeat call. The flag only ever concerned the parent project.
- **`markAccessLost` was built but is not reachable from this phase.** §12 says a
  brand-new connect attempt against a revoked installation simply rejects, with no row to
  mark. It exists because the transition is a property of the GitHub client this phase
  owns, and Phase 03's background work is the first thing that can _be_ running when
  access disappears. Its doc comment says exactly that.
- **`RepositoryDetail.indexJob` is typed as literal `null`**, not `unknown`, so Phase 03
  widening it is a compile error at every call site — the same trick
  `ProjectDetail.repositories: never[]` used to force this phase's hand, and which is
  cashed in here.
- **`ProjectDetail.repositories` is populated through the repositories module's
  _service_, not its repository layer.** The projects module has no business knowing how
  repositories are stored, only how to ask for them.
- **`connectionStatus` values that the column allows but the union does not fall back to
  `ACTIVE` on read** rather than throwing. The column is a plain `String` (§5), so a
  hand-edited row must not 500 a read.

## 27. Repo issue found and fixed during the smoke pass: `INNGEST_DEV`

`apps/worker/.env` sets `INNGEST_DEV`; `apps/api/.env` did not. The consequence is
silent by design: every event `apps/api` emitted went to Inngest Cloud, came back
`401 Event key not found`, was logged at `error`, and was dropped — because emission is
deliberately non-fatal. Nothing failed; the event simply never appeared in the Dev
Server, which is §8's entire acceptance signal.

This affected Phase 01's `project/deleted` too and had never been noticed, because
nothing consumed that event either.

`INNGEST_DEV` is now documented in `.env.example` with the explanation. **It must be set
in both `apps/api/.env` and `apps/worker/.env` for local development** — `.env` files are
untracked, so this is a step a human has to take (see §29).

## 28. Smoke verification — what was actually exercised

Run against `docker compose` Postgres + Redis, `apps/api` on :4000, `apps/worker` on
:4500, and the Inngest Dev Server on :8288, with a seeded `User` + `Session` +
`Account` + `Project` + `GithubInstallation`. The `Account` carried a deliberately
invalid OAuth token and the App private key in `.env` is not a real one — so **every
GitHub call was guaranteed to fail**. That is the point: what is being proven is that
each failure reaches the GitHub layer and comes back as a _distinct, correctly-shaped_
error rather than a 500.

| Request                                                              | Result                                                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/github/installations` — no cookie                          | **401**                                                                                                                                      |
| `GET /api/github/installations` — signed in                          | **401** `UNAUTHENTICATED`, "Your GitHub sign-in needs to be refreshed" — the invalid OAuth token was rejected by GitHub and mapped correctly |
| `GET /api/github/installations/:owned/repos?q=hello`                 | **503** `SERVICE_UNAVAILABLE` — token mint failed on the fake private key                                                                    |
| `GET /api/github/installations/999999/repos`                         | **403** `FORBIDDEN`, "not available to your account" — ownership check fired _before_ any GitHub call                                        |
| `POST …/repositories` `{repoUrl: "https://github.com.evil.com/o/r"}` | **400** `VALIDATION_ERROR`, `fieldErrors.repoUrl: ["That doesn't look like a GitHub repository URL"]`                                        |
| `POST …/repositories` with **both** fields                           | **400**, field-level message on both fields                                                                                                  |
| `POST …/repositories` `{repoUrl: ".../octocat/Hello-World"}`         | **503** — resolved the installation, minted (failed), returned cleanly                                                                       |
| `POST …/repositories` `{repoUrl: ".../someoneelse/repo"}`            | **403** with the installation-settings message                                                                                               |
| `POST /api/projects/{foreign}/repositories`                          | **404** `"Project not found"`                                                                                                                |
| `GET`/`DELETE /api/repositories/nope`                                | **404** `"Project not found"`                                                                                                                |
| `GET /api/projects/:id`                                              | **200**, `repositories: []` — the widened field serializes                                                                                   |

**No 500s. No hangs.** The token-mint retry behaved as Prompt 1 built it: three attempts
at 250ms/500ms backoff, then a clean `ServiceUnavailableError` — visible in the log as
three `installation token mint failed at the network layer` lines followed by one
`github request failed`.

**§20's observability requirement holds on the wire, not just in tests.** Every
`github.client` and `repository.service` line carries `installationId`; every tenancy
denial on a repository route carries `repositoryId` (`{"reason":"MISSING",
"repositoryId":"nope"}`); `traceId`, `userId` and `projectId` come from
AsyncLocalStorage on every line including the request-completion line.

**§8's acceptance signal: confirmed.** With `INNGEST_DEV` set (§27), the real
`emitRepositoryIndexRequested` helper, the real client, and the real payload produced:

```json
{
  "name": "repository/index.requested",
  "data": {
    "mode": "FULL",
    "projectId": "…",
    "reason": "connected",
    "repositoryId": "…"
  }
}
```

visible in the Dev Server, and `GET /v1/events/{id}/runs` returned **0 runs** —
confirming no consumer exists, exactly as §8 requires.

**What this does NOT prove**, stated plainly: no successful connect has ever happened.
No `Repository` row has been created through the API. The 409, the 422s, and the
dual-project case are covered by unit tests with stubbed GitHub and stubbed Prisma, and
by nothing else. See §29.

## 29. Outstanding — requires human action

Supersedes §14. Everything §14 listed is still outstanding except where noted.

- [ ] **No real GitHub App has been registered**, so `GITHUB_APP_ID` /
      `GITHUB_APP_PRIVATE_KEY` are placeholders and every token mint in this
      environment fails at the key decoder. `docs/github-app-setup.md` is the runbook;
      nobody has walked it.
- [ ] **No repository has ever been connected end to end.** The success path —
      `Repository` row created, `indexStatus=PENDING`, `repository/index.requested`
      emitted from the _route_ rather than from a script — is unverified against real
      GitHub. Everything about it is unit-tested against stubs.
- [ ] **§14's manual verification list is entirely unrun**: the 403 for a repo the
      installation cannot see, the 422 for an empty repository, the 409 for a double
      connect, the dual-project case, and the disconnect. All are unit-tested; none has
      met real GitHub.
- [ ] **The empty-repository probe has never seen a real GitHub response.** The
      `size === 0` ambiguity and the `404`-on-a-branch signal (§23) are reasoned from
      GitHub's documented behavior and tested against stubs. The _`size` unit itself_ is
      the one thing here that **was** verified against live GitHub (§22).
- [ ] **`INNGEST_DEV` must be set in `apps/api/.env`** (§27). `.env` is untracked, so
      this cannot be done for you. Without it, every emitted event is silently dropped.
- [ ] **`GET /user/installations` has never returned a real installation.** The pagination
      loop, the `suspended_at` mapping, and the account-type field are exercised only
      against stubs.
- [ ] **No integration tests were added for the new routes.** Prompt 3 owns the full
      test suite, including the cross-tenant extension §14 requires (user B cannot view,
      connect to, or disconnect user A's repository). The unit-level tenancy tests cover
      the logic; the HTTP-level cross-tenant proof does not exist yet.
- [ ] **CI still does not run** — `.github/workflow/ci.yml` is in a misnamed directory
      and fully commented out (§13). Nothing in this phase has been verified by CI.
- [ ] **`pnpm format:check` still fails**, from before this phase (§13). New files match
      their neighbours' style instead.
- [ ] **No staging verification.** §16's Definition of Done requires "a real GitHub App
      installed on a real (test) account/org, with a repository successfully connected
      end-to-end in staging". No staging environment exists.

## 30. Where the phase document is wrong or under-specified

Stated plainly rather than complied with silently:

1. **§7's 403 on `GET`/`DELETE /api/repositories/:id` is a security regression** and is
   not implemented. See §18.
2. **§7's connect body has no `installationId`**, which forces the id path to search the
   user's installations. See §25. The picker already has the value.
3. **§12's "Empty repository — detection: `size: 0` or no default branch" is not
   sufficient on its own** and, taken literally, rejects freshly pushed repositories.
   See §23 for what was built instead.
4. **§12's size-cap row says "~500 MB / 25k files per plan.md A7"** as though both were
   checkable from the metadata call. Only the size is. See §22.
5. **§9's table describes `GET /user/installations` as sending "OAuth session (to
   identify the user) → looked up against stored `GithubInstallation` rows"**, which
   reads as though the endpoint were a database lookup. It is a real GitHub call
   authenticated with the user's OAuth _token_, and that token has to be read off the
   `Account` row — a detail §9 does not mention and which materially affects the design.
6. **§6's `sizeBytes` column against GitHub's KiB `size` field** is a unit mismatch the
   phase document never acknowledges. Resolved in §22.
7. **§8's payload is fine, but §7 says the connect returns `{ repository: Repository }`
   — the Prisma model.** It cannot be: two columns are `BigInt` and `JSON.stringify`
   throws on those. What is returned is `RepositoryDto`, with both converted to strings.

---

# Phase 02 — Prompt 3 (tests, frontend, phase closeout)

Records the judgment calls made implementing **Prompt 3**: the fixture harness, the
integration and cross-tenant test extensions, the frontend, the documentation pass, and
the manual verification this environment can actually perform. Prompts 1 and 2's
entries above are binding for this work. This closes Phase 02 — §43 is the honest
account of what still cannot be verified from here.

## 31. Inherited baseline (verified before writing any Prompt 3 code)

Every command run against the tree as inherited from Prompt 2, before a line changed:

| Command                 | Result                                            |
| ----------------------- | ------------------------------------------------- |
| `pnpm install`          | Clean — lockfile up to date, 6 workspace projects |
| `pnpm db:generate`      | Prisma Client 7.9.1 generated                     |
| `pnpm lint`             | Pass, 0 errors                                    |
| `pnpm typecheck`        | Pass — 3 tasks                                    |
| `pnpm test:unit`        | Pass — **19 files, 346 tests**                    |
| `pnpm test:integration` | Pass — **6 files, 65 tests**                      |
| `pnpm build`            | Pass — 3 tasks                                    |
| `prisma migrate status` | Up to date, 3 migrations                          |

All five API endpoints confirmed mounted; `repository/index.requested` confirmed
declared with no consuming Inngest function (only `noop.ts` exists under
`apps/worker/src/inngest/functions/`). **Nothing was red.** No commit for this
sub-task, per its own instructions.

## 32. The fixture harness: nock, verified rather than assumed, and one bug it caught

**nock@14.0.17 over msw** — `plan.md` §40.3 sanctions either. The deciding fact, checked
empirically before committing to either (`tests/fixtures/github/README.md` links this
reasoning): Node 22's global `fetch` is backed by undici, and nock's classic
interception patches the `http`/`https` core modules, which undici's fetch
implementation does not route through on its own. A throwaway script —
`nock("https://api.github.com").get(...).reply(200, {...})` followed by a plain
`fetch(...)` — was run against the installed version before writing a single fixture
test, confirming v14 actually intercepts it (POST with header matching, GET with query-
string matching, a `304` with no body, and `disableNetConnect()` correctly rejecting an
unmocked request all verified directly, not from nock's changelog).

**The harness runs the REAL default HTTP client**, not an injected stub — the point of
distinguishing it from Prompt 1's existing `app-auth.test.ts` / `octokit-factory.test.ts`
/ `github-services.test.ts`, which inject a fake `http`/`fetch` function or a stub
`Octokit` and assert against hand-built inline response objects. Those are still the
right tool for exhaustively enumerating edge cases (and they already did, thoroughly —
see §34). `github-fixtures.test.ts` proves a different thing: that the default client,
left alone, actually speaks GitHub's protocol against something shaped like a real
response — real header casing, real query strings, a body that came from a fixture
file on disk rather than a JS object literal in the test.

**Fixtures are schema-derived, not recorded — stated plainly, not hedged.** No real
GitHub App exists in this environment (Prompts 1/2 already established this; nothing
changed). Every fixture was hand-built against GitHub's documented response shapes,
with every field the code reads present and a realistic value (real-magnitude ids —
`1296269` kept from the existing test suite's own convention for the canonical
`octocat/hello-world` example), and is marked as such in
`tests/fixtures/github/README.md`, which also lists exactly what a human does to
replace them with real recordings once an App exists. This is in **§43**, not glossed
over.

**A real bug, caught by the harness itself, not by inspection:** the first version of
`access-token-success.json` hardcoded `"expires_at": "2026-01-01T13:00:00Z"`. That was
correct on the day it was written and silently wrong by the time the suite actually
ran against `Date.now()` — `effectiveTtlSeconds` saw an "already expired" token, cached
it with a `0` TTL, and the very next cache-reuse test failed with `ServiceUnavailableError`
because there was nothing to reuse and only one nock interceptor had been registered.
Fixed by making `expires_at` a `__EXPIRES_AT__` placeholder substituted at load time,
the same mechanism already used for the rate-limit-reset timestamp. Recorded here
because it is a small, concrete example of exactly the failure mode a fixture built
from a static example (rather than recorded live) is prone to, and it is worth staying
alert to when the real recordings eventually replace these.

## 33. Sanitization vs. realism — the `ghs_` prefix tension, resolved by not using it

Sub-task 3.1 asks for two things that are in direct tension for one specific field: a
`token` value that is realistic (GitHub's real installation tokens are `ghs_` plus 36
base62 characters), and a sanitization check that fails a fixture containing anything
shaped like `ghs_`. A fixture built to look realistic on that one field would trip its
own guard.

**Resolved by not chasing realism on that one field.** `access-token-success.json`'s
`token` is `"FIXTURE-INSTALLATION-TOKEN-DO-NOT-USE"` — no real GitHub prefix at all.
The code under test only cares that `body.token` is a non-empty string; it never
inspects the prefix. This keeps the sanitization check a **blunt, simple prefix match**
(exactly what sub-task 3.1 asked for — `ghs_`, `ghp_`, `gho_`, `ghu_`, `ghr_`,
`github_pat_`, `-----BEGIN`), rather than a "does this look like a REAL secret, as
opposed to a fixture that merely resembles one" heuristic, which is a much harder
problem to get right and the kind of thing that silently rots. The alternative — giving
the check a length/entropy threshold so a short obviously-fake string could keep the
`ghs_` prefix — was considered and rejected: it makes the guard's own logic the thing
most likely to have a bug, for a cosmetic gain.

The sanitization test is scoped to `apps/api/tests/fixtures/github/*.json` specifically,
not the whole repository — the pre-existing inline fixture tokens in
`app-auth.test.ts`/`octokit-factory.test.ts` (`"ghs_thisisafakeinstallationtokenvalue"`,
already Prompt 1's work, already fine) are a different kind of artifact (inline test
literals, not the fixture corpus sub-task 3.1 asks to guard) and were not touched.

## 34. GitHub client fixture tests (sub-task 3.2) — mostly already there; the gap was small

Before writing anything, the existing coverage was read in full
(`app-auth.test.ts`, `octokit-factory.test.ts`, `github-services.test.ts` — all Prompt
1's work). It already covered, thoroughly, against injected stubs: token cache reuse
with hit/miss logging, the exact 49:59/50:01 expiry boundary, a mint-level rate limit
failing fast as `GithubRateLimitError`, an ordinary-call rate limit scheduling a retry
through the real `@octokit/plugin-throttling`, ETag `304` handling, pagination past 100
for both installation-listing endpoints, a 401 mint never retried, a 5xx retried to the
cap with a clean error, and the token never appearing in any log line across every
path. Re-testing all of that against fixtures too would have been the bulk of the work
for very little new confidence.

So `github-fixtures.test.ts` (added on top of the harness commit) exists to prove two
things the existing suite could not, by construction: (1) that the **real** default
HTTP client — not an injected one — carries all of the above correctly, and (2) that
each of the five `GET /repos/{owner}/{repo}` fixture variants sub-task 3.1 names by name
(normal, ambiguous-empty-with-probe, oversized, private-no-access, fork with an unusual
default branch) maps through `getRepository`/`probeBranch` correctly. A "full chain" test
(mint a token from a fixture → build an Octokit with it → fetch a repository, also from
a fixture, asserting the SAME token value reaches the `Authorization` header on the
second call) is the one test in this file with no equivalent anywhere else — it is the
thing a fixture harness is for that a collection of per-layer unit tests, however
thorough, cannot show on its own: that the layers actually compose.

**"Token never persisted"** — the one item in sub-task 3.2's table not covered here —
needs a real Postgres, so it lives in the integration suite instead; see §35.

**On timing, followed literally:** every test in `github-fixtures.test.ts` uses an
injected `sleep`/`now`, or — for the one case inside `@octokit/plugin-throttling`'s own
Bottleneck-backed scheduler, which cannot be handed an injected clock without
reimplementing the plugin — an `x-ratelimit-reset` set a few seconds in the **past**.
Read from the installed `@octokit/plugin-throttling@11.0.5`'s own source
(`dist-src/index.js`): the computed wait is
`Math.max(Math.ceil((resetMs - now) / 1000) + 1, 0)`, so a reset several seconds in the
past clamps to `0` — the retry is real, goes through the real plugin, and costs no wall
time. The whole file runs in well under half a second. This is worth contrasting with
the **pre-existing** `octokit-factory.test.ts`'s rate-limit test (Prompt 1), which uses
a reset one second in the _future_ and genuinely sleeps for it — that file's two
slowest tests take ~1s and ~2s respectively. Not fixed here (it was not this sub-task's
file, and touching Prompt 1's tests was not asked for), but flagged: it is exactly the
"flakiest test in six months" pattern sub-task 3.2 warned against, and the fix (a
past-dated reset, matching the technique above) is a one-line change whenever someone
next touches that file.

## 35. Integration tests (sub-task 3.3) — GitHub mocked at the services boundary, not with nock

`repositories.test.ts` mocks `github/services/installation.github.js` and
`repository.github.js` with `vi.mock`, the same boundary `emit.js` is already mocked at
in `projects.test.ts` — not `nock`. Deliberate: the GitHub _client_ (retry, rate
limiting, ETag caching, token minting) already has its own dedicated, thorough fixture
suite (§32/§34); re-exercising it through a real HTTP layer here as well would mean
every integration test also carries the client's own concerns, coupling two suites
that should be able to fail independently and pointing at different things when they
do. What this suite tests instead — the thing nothing else does — is the route →
controller → service → repository → **real Postgres** pipeline: tenancy resolution,
the `(projectId, githubRepoId)` composite key under real concurrency, the 409
pre-check-plus-constraint pattern actually holding against the database, and the DTO
boundary actually serializing (§15's "does not leak installationId/githubRepoId as
anything but decimal strings" is asserted against a real HTTP response body, not a
unit-level DTO mapper).

**`tests/integration/repository-helpers.ts`** is new, mirroring `auth-helpers.ts`'s
role: `seedInstallation` writes a `GithubInstallation` row **directly via Prisma**,
not through `GET /api/github/installations`'s sync route. That route's own
correctness is not what this suite is testing — `repository.service.connectRepository`
only ever reads the _stored_ rows — so seeding them directly keeps this suite decoupled
from the sync flow, the same reasoning `seedSignedInUser` already uses for `Session`
rows instead of running the OAuth dance. `githubRepoMetadata` is a small factory for a
realistic `GithubRepositoryMetadata`, and `assertNoTokenPersisted` scans every
`Repository`/`GithubInstallation` column value (serialized once, with a `BigInt`-safe
replacer) for anything shaped like a real token — meaningful even though this suite's
GitHub layer is mocked and never mints one: it is a **structural** assertion that the
schema itself has nowhere a token could land, not merely that this particular test run
didn't write one.

**Every required case from the sub-task's table passed on the first real run against a
Testcontainers Postgres** — no backend bug was found while writing this file. The
23 (later 24, once the `installUrl` positive-path test was added — see §37) cases,
including the concurrency test (`Promise.all` of two identical connects), the
dual-project case, and the idempotent-DELETE case, are exactly what phase-02 §14/§15
ask for.

## 36. Cross-tenant extension (sub-task 3.4) — extended in place, and one test-design bug caught by the suite itself

`cross-tenant.test.ts` was extended, not forked, per the sub-task's explicit
instruction and the file's own header ("written now, extended forever"). Three new
`describe` blocks: repository access (404 on every route, including the
"foreign-vs-nonexistent produce byte-identical responses" no-oracle check this file's
pattern already established for projects), GitHub installations (the 403 exception for
an installation id user B does not own, confirmed via `installationGithub.listInstallationRepositories`
never being called), and the dual-project case — the one sub-task 3.4 calls out as
"the one that catches the real bug."

**Two test-design bugs, both caught by the suite itself on the first run, neither a
backend bug:**

1. `beforeEach` connects a repository for user A as shared setup (mirroring how
   `projectOfA` is already unconditionally created for every test in this file). The
   FIRST version of the "POST rejects before any GitHub call" test asserted
   `getRepository` was never called — and failed, because the mock's call history from
   _setup's own_ connect call was still there. Fixed with an explicit `mockClear()`
   (history only, not queued implementations) at the end of `beforeEach`, after setup's
   own use of the mock completes.
2. The first version of "user B's installations list only contains user B's own"
   mocked `listUserInstallations` to return an **empty** array for B, expecting the
   already-directly-seeded `installationOfB` row to show up anyway. It didn't —
   `repository.service.syncInstallations` returns what _that sync call_ found, not a
   raw re-read of every stored row (`repositoryService.listInstallations`, the
   store-only-read function, exists but the controller does not call it — see §37 for
   why that is correct behavior, not a bug). In production this distinction is
   invisible, because `listUserInstallations` always returns GitHub's complete,
   fully-paginated current list — a sync genuinely finding _nothing_ for an
   installation that still exists is not a real scenario. Fixed by having the mock
   **confirm** B's already-seeded installation (matching what would actually happen),
   which is also the more honest test of the scoping property: A's installation is
   never in B's mocked GitHub response and never in B's response, for the right
   reason.

**On the FOREIGN vs MISSING log-content assertion**, sub-task 3.4's explicit ask: not
duplicated here. `src/lib/auth/tenant-access.test.ts` (Prompt 2) already asserts the
exact `{projectId, userId, reason, repositoryId}` payload for FOREIGN, MISSING,
DELETED, and MISMATCH on the repository path, by mocking `createLogger` directly —
`requireTenantAccess`'s logger is a module-level constant, not an injectable
parameter, so there is no seam to swap it through at the integration layer the way
`github-fixtures.test.ts` swaps a pino instance into `createInstallationTokenService`.
The alternative (spying on real stdout) would race pino's own asynchronous
`sonic-boom`-backed writes rather than proving anything reliable. This file instead
proves the same distinction the way an HTTP test honestly can: every case gets the
identical 404 regardless of which internal reason produced it, and the database is
asserted unchanged — the caller-visible half of the contract, which is what an
integration test is actually positioned to verify. Recorded here, not silently
substituted, per this prompt's own rule about being explicit rather than quietly doing
something else. See also §44.4.

## 37. The install-URL decision, confirmed: the API returns it

Sub-task 3.5 asked for a decision between a `NEXT_PUBLIC_GITHUB_APP_SLUG` in
`apps/web` and returning the install URL from the API. **The API returns it** —
`GET /api/github/installations`'s response gained `installUrl`, built in
`github.controller.ts` from `env.GITHUB_APP_SLUG` (already validated at `apps/api`
boot; cannot be built from an unset value). No new `apps/web` environment variable was
added. Reasoning, as the sub-task's own text already argued and this implementation
confirms: a slug duplicated into two `.env` files across two deploy targets drifts
silently, and the failure mode — a dead install link — is not one anyone notices
quickly, whereas a value read once at the API's own already-validated boot has exactly
one place it can be wrong.

**A secondary, smaller decision inside sub-task 3.5:** `listInstallations()` in
`apps/web/src/lib/api.ts` treats a `401` from `GET /api/github/installations` as a
typed `{ ok: false, reason: "UNAUTHENTICATED" }` result, not a throw. This 401 is real
and distinct from an invalid _session_ (which never reaches this call —
`(app)/layout.tsx` already redirected before this page renders): it means the user's
stored GitHub OAuth token is missing or was revoked
(`repository.service.ts`'s `syncInstallations`), which is an expected, actionable
state, not a crash. `ProjectDetailPage` renders it as an inline alert
("Your GitHub sign-in needs to be refreshed — sign out and back in") instead of letting
it fall through to `apps/web/src/app/error.tsx`'s generic boundary. Verified live: see
§40.

## 38. Frontend architecture — server-fetched, client-interactive, and one lint rule that changed a hook's shape

Every list this phase's UI needs (`installations`, `repositories`) is fetched
**server-side** in `ProjectDetailPage` — same discipline `apps/web/src/lib/api.ts`'s
own header already states (`cache: "no-store"`, because a cached cross-tenant response
is a leak) and the same pattern `listProjects`/`getProjectDetail` already established.
`InstallationsPanel`'s "Refresh" button does not fetch client-side; it calls
`router.refresh()`, which re-runs the server component and, with it, the real
GitHub-sync — which is the correct behavior for a control whose entire job is "do the
sync again." `ConnectRepositoryDialog` receives the same server-fetched
`installations` array as a prop rather than re-fetching it, so opening the dialog can
never show a different installation list than the page around it already does.

The **picker's search** is the one place this phase's UI _does_ fetch client-side
(`fetch` directly against `API_URL`, `credentials: "include"`, matching
`create-project-dialog.tsx`'s established pattern) — it has to, since it is debounced,
interactive, and scoped to whichever installation is currently selected in the dialog,
none of which a server component can drive.

**`react-hooks/set-state-in-effect`** (from the installed `eslint-plugin-react-hooks@7.1.1`,
part of the React Compiler-era rule set `eslint-config-next` 16 now ships) flagged the
picker's first draft: `setReposLoading(true)` / `setReposError(null)` called
synchronously at the top of the search effect, before the `fetch`. The fix was not a
suppression — it was restructuring so that no `setState` call happens synchronously in
the effect body at all: `queryResult` is written only from inside the fetch's own
`.then()`/`.catch()` callbacks, tagged with the query key it resolves; "loading" is
then a **derived** comparison (`queryResult?.key !== currentKey`) rather than its own
piece of state, true by construction until a result for the _current_ key has actually
landed. Recorded because it is a genuine, fairly recent React-ecosystem constraint —
not obvious from the phase document or from general React knowledge predating the
React Compiler's linting — and the pattern (derive "in flight" from a tagged
last-result rather than toggling a boolean at the top of an effect) is the one to reach
for again if a later phase's UI needs another debounced-fetch picker.

**Where the "install entry point" lives** was a judgment call, not specified by the
phase document beyond §18's file list (which names only the existing project detail
page, no new route). Built as a section on `ProjectDetailPage` (`InstallationsPanel`,
above the repositories `Card`) rather than a standalone settings page — matching §18
literally, and because there is nowhere else in this phase's scope a user would
naturally look for it. A dedicated `/settings/github`-style page is a reasonable future
evolution once there is more than one thing to put on it, but nothing in this phase
needs it yet.

## 39. Bugs found and fixed during this prompt's testing

**None in Prompt 1 or 2's backend code.** Every required case in §14/§15 — the four
distinct invalid-connection errors, the 409 pre-check and its unique-constraint
backstop under real `Promise.all` concurrency, the dual-project case, idempotent
disconnect, the cross-tenant 404s and the installation-403 exception — passed against
a real Testcontainers Postgres on the first run of each new test file. The live smoke
pass in §40 (hitting the actually-running `apps/api` process, not a test harness)
reproduced Prompt 2's own §28 results exactly, including the same three-attempt
250ms/500ms backoff on a fake private key. This is stated plainly because it is the
honest outcome, not because it was expected going in — sub-task 3.3's own instructions
note that tests "will find backend bugs" as the reason they come before the frontend;
this time they didn't, and that is worth recording rather than silently omitting.

Three issues _were_ found and fixed, all in work written during this prompt itself,
not inherited:

1. A stale hardcoded `expires_at` in a fixture (§32).
2. Two test-design bugs in the cross-tenant extension — a leaked mock call count, and
   an unrealistic empty-sync mock (§36).
3. A lint-rule incompatibility in the picker's first draft (§38).

None of these reflect on Prompt 1/2's code; all three are corrected in the commits
that introduced them, not left as caveats.

## 40. Manual verification — what this environment could actually do

Run against `docker compose` Postgres + Redis, `apps/api` on :4000 (restarted mid-pass
specifically to pick up `INNGEST_DEV=1`, added to `apps/api/.env` — see §43), `apps/web`
on :3000, `apps/worker` on :4500, and the Inngest Dev Server on :8288, with a
throwaway seeded `User` + `Session` + `Project` + `GithubInstallation` created and
destroyed via Prisma directly (never committed; cleaned up after each pass;
`docker exec redisdb redis-cli ping` confirmed `PONG` throughout). The `.env` GitHub
App credentials are Prompt 1's placeholders — not a real key — so, as in Prompt 2's own
§28, every real GitHub call was guaranteed to fail; what was being proven is that each
failure reaches the GitHub layer and comes back as a distinct, correctly-shaped error,
never a 500 or a hang.

phase-02 §14's Manual Verification steps, walked as far as this environment allows:

| #   | Step                                                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Install the App on a test account with 2–3 repos                                               | **Blocked** — no real GitHub App exists here (unchanged from Prompts 1/2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2   | Connect one repository; confirm `indexStatus=PENDING`                                          | **Done, with a caveat.** The full HTTP → validation → GitHub-client chain was exercised live and correctly fails at the GitHub layer (403/503, matching Prompt 2's §28) since there is no real App to succeed against. A **successful** connect — through the real UI, against a real repository — was proven by (a) the automated integration suite (98 tests, real Postgres, GitHub mocked) creating a real `PENDING` row through the real HTTP stack, and (b) directly seeding a `Repository` row and confirming, live, that the project page renders it correctly ("Waiting to be indexed", correct badges, correct disconnect action) — see §41 for what the seeded-vs-real distinction does and does not prove |
| 3   | Connect a repository the installation lacks access to (by id); confirm 403                     | **Done** for the URL-owner-mismatch case, live (`someone-else/their-repo` → 403 `NO_ACCESS_MESSAGE`); done for the id-path and the GitHub-reports-inaccessible case via the fixture and integration suites. Real GitHub returning a genuine 404-for-a-repo-it-can't-see is unreachable without a real installation                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | Connect an empty repository; confirm 422                                                       | **Done via the fixture and integration suites** (both the unambiguous and the ambiguous-with-probe cases); unreachable live without a real empty GitHub repository                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5   | Connect the same repository to the same project twice; confirm 409                             | **Done via the integration suite**, including under real `Promise.all` concurrency against a real unique constraint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6   | Connect the same repository to two different projects; confirm both succeed                    | **Done via the integration and cross-tenant suites** — including the dual-project case across two different _users_, which is the stricter version of this check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 7   | Disconnect a repository; confirm `connectionStatus=DISCONNECTED` and it leaves the active list | **Done live**: seeded a repository, curled `DELETE` against the running server, confirmed the row's `connectionStatus` and its disappearance from `GET /api/projects/:id`'s `repositories` array, confirmed a repeat `DELETE` is still `202` and does not move `updatedAt` again                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**What "done live" does and does not prove**, stated once rather than repeated seven
times above: it proves the code path from an HTTP request through the real running
Express process, the real Postgres, and (for the failure cases) the real GitHub client
attempting real cryptographic operations against a fake key — genuinely more than an
automated test proves, since it is the actual server binary rather than a test harness
importing the app. It does **not** prove anything about real GitHub's actual wire
behavior, because nothing in this environment can reach real GitHub. Both halves
matter and neither should be read as standing in for the other.

**Frontend, at the SSR level** (no browser available this session — see §43): the
project detail page was fetched with `curl` using a real session cookie, for both a
user with no stored GitHub OAuth token (confirming the graceful 401 alert from §37
renders, not a crash) and a user with a seeded, connected repository (confirming the
repository card, its badges, its "Waiting to be indexed" caption, and the disconnect
button all render with the right data, and that the "Connect repository" button
carries `disabled=""` and the correct `title` when there are zero installations). A
signed-out request to `/projects/:id` was confirmed to 307-redirect to `/signin`. What
this does **not** prove: client-side interactivity (opening the dialog, typing in the
search box, the debounce actually firing, clicking through to a successful connect) or
the absence of a hydration warning, since neither is observable without a browser and
none was available this session (the user declined the Claude-in-Chrome connection).

## 41. Inngest verification (§14 External Service Verification, §8's acceptance signal)

Confirmed via the Inngest Dev Server's own APIs, not by reading the code:

- `PUT http://localhost:4500/api/inngest` → `{"message":"Successfully registered","modified":false}`;
  `GET` on the same URL → `{"function_count":1,...}`.
- The Dev Server's GraphQL API confirms one app, `gitprreviewer-worker`, with
  `functionCount: 1` — matching "the app registers with exactly one function."

**No real successful connect happened in this environment (§40), so the event was not
observed arriving from a real connect.** Per this prompt's own instruction for exactly
this situation, the actual production `emitRepositoryIndexRequested()` function
(`apps/api/src/inngest/emit.ts`) was called **directly**, with the same environment the
live `apps/api` process uses, with a realistic payload — not a hand-crafted raw event
posted at the Dev Server. This is stated here as plainly as it needs to be: **the event
below was triggered manually, by calling the real emit function from a script, not by
a real repository connect.**

`GET http://localhost:8288/v1/events?limit=5` returned:

```json
{
  "name": "repository/index.requested",
  "data": {
    "mode": "FULL",
    "projectId": "manual-verification-project-id",
    "reason": "connected",
    "repositoryId": "manual-verification-repository-id"
  }
}
```

— matching phase-02 §8's payload contract exactly (`{projectId, repositoryId, mode,
reason}`), and `GET /v1/events/{id}/runs` on that event returned **0 runs**, confirming
no consumer exists — exactly what §8 requires this phase to show.

## 42. What Phase 03 inherits

- A `Repository` row model whose only reachable state this phase produces is
  `indexStatus=PENDING`, `connectionStatus=ACTIVE` — verified structurally (DB
  constraints, the unique-constraint-backed 409) and, for the one row this environment
  could produce without a real GitHub App, empirically (§40 step 7's seeded-and-then-
  disconnected row).
- The full `IndexStatus` enum, with only the first transition exercised — Phase 03 owns
  `PENDING → INDEXING → INDEXED/FAILED` and beyond.
- The GitHub client (`app-auth.ts`, `octokit-factory.ts`) — now proven, in addition to
  Prompt 1's stub-based coverage, against a fixture harness running the real default
  HTTP client. Reuse it; do not construct a second Octokit anywhere.
- `tests/fixtures/github/` and its loader pattern (`loadFixture` with `__PLACEHOLDER__`
  substitution) — reusable for any later phase's own GitHub-fixture needs, with the
  same schema-derived-not-recorded caveat until a human replaces them (§43).
- The `repository/index.requested` contract, now confirmed to round-trip through a
  real (locally running) Inngest Dev Server with the exact documented payload shape.
- **The un-awaited emit** (`repository.service.ts`'s `connectRepository`, §20 above) —
  Prompt 2 already flagged this as the thing to revisit once `repository-index` exists
  and delivery starts mattering; nothing in Prompt 3 changed that calculus, and nothing
  here makes it more urgent than Prompt 2 already said it was.
- **The noop function's deletion** — still Phase 03's, for the same reason Prompt 2
  gave (§21): it is currently the only proof the worker is discoverable at all, and
  `repository-index` is what should replace it, not an empty function list.
- `apps/web/src/lib/api.ts`'s `getRepository(id)` — built per sub-task 3.5's explicit
  ask, not yet called from any page (there is no single-repository route in this
  phase's scope). Whoever builds one — plausibly Phase 03, to show indexing progress —
  has the typed call already waiting.
- A frontend pattern worth reusing rather than rediscovering: server-fetch the list,
  pass it as a prop into any dialog that needs it, mutate through a direct
  `credentials: "include"` fetch, and call `router.refresh()` on success rather than
  managing local list state. Every component this phase added follows it.

## 43. Outstanding — requires human action

Supersedes §14 and §29. Everything those sections listed is **still outstanding**
except where marked done below — none of it could be completed from this environment,
and Prompt 3 does not change that.

- [ ] **No real GitHub App has been registered.** `docs/github-app-setup.md` remains an
      unwalked runbook.
- [ ] **No real installation exists, and no repository has ever been connected against
      real GitHub.** §40 is the most this environment can do: the full code path
      exercised live against a fake key, and the success path proven through automated
      tests plus a directly-seeded row's rendering. Neither substitutes for an actual
      end-to-end connect in staging, which §16's Definition of Done explicitly
      requires and which is **still not done**.
- [x] **`INNGEST_DEV` set in `apps/api/.env`** — done, but **only in this local
      environment's untracked `.env` file**, which does not propagate anywhere. Every
      other clone, every CI run (if CI ran, which it does not — see below), and every
      staging/production environment still needs this set independently, per
      `.env.example`'s own comment and README's now-corrected Inngest section.
- [ ] **Replace the schema-derived fixtures in `tests/fixtures/github/` with real
      sanitized recordings**, once a real App and installation exist. The fixtures'
      own README lists the exact steps. Treat any test that then needs to change as
      the interesting finding, not a nuisance — it means this phase's assumptions
      about GitHub's actual response shape were wrong somewhere.
- [ ] **CI still does not run anything in this phase** — `.github/workflow/ci.yml` is
      in a directory GitHub never reads (`workflow`, not `workflows`) and is entirely
      commented out. Unchanged since Prompt 1 flagged it in §13; still not fixed, per
      this prompt's own explicit instruction to flag rather than silently fix it.
      **Nothing in Phase 02 — any of the three prompts — has been verified by CI.**
- [ ] **`pnpm format:check` still fails** — 186 files now (152 at the end of Prompt 2;
      the growth is every file this prompt added, all matching their neighbours'
      ~100-column style rather than the broken 80-column fallback the misconfigured
      `prettier.config.js` produces). Same root cause Prompt 1 diagnosed in §13, same
      recommended fix (rename `prettier.config.js` → `.cjs`, or fold `printWidth: 100`
      into `.prettierrc` and delete it, then run `pnpm format` as one isolated commit),
      still deliberately not performed — it is a repo-wide reformat with a larger and
      riskier diff than anything in this phase, and was out of this prompt's scope.
- [ ] **No staging environment exists** (outstanding since Phase 00). §16's Definition
      of Done requires a real GitHub App installed on a real account with a repository
      connected end-to-end **in staging** specifically — not merely "somewhere a real
      App exists." Nothing in this phase satisfies that.
- [ ] **Full browser verification was not performed.** §40's SSR-level check (curl plus
      a real session cookie) confirms the server-rendered output is correct and free
      of the error markers a crash would leave, but proves nothing about client-side
      hydration, the picker's actual keyboard navigation, or the debounced search
      firing correctly in a real browser. The Claude-in-Chrome connection was offered
      and declined for this session.
- [ ] **Token caching against real GitHub is still unverified** — Prompt 1's boundary
      tests and this prompt's fixture harness both prove the _logic_ is correct against
      a fake or a schema-derived response; neither is real GitHub confirming that two
      calls in quick succession genuinely reuse one token, or that a call past 50
      minutes genuinely re-mints, against the real service.
- [ ] **The App has never been revoked on GitHub's side.** The `GithubAccessRevokedError`
      path is thoroughly tested (unit, fixture, and — via a fake key producing a
      network-layer failure rather than a real 401 — indirectly live), but "revoke a
      real installation and watch the next mint attempt get classified correctly" needs
      a real installation to revoke.

## 44. Where the phase document — or this prompt's own instructions — were wrong or under-specified

Continuing Prompt 2's §30 numbering context rather than restarting it, but kept as its
own list since these are Prompt 3's own findings:

1. **Sub-task 3.4's log-content assertion assumes a seam that does not exist.**
   "Assert the denial warn log lines carry the right reason" implicitly assumes
   `requireTenantAccess`'s logger can be swapped or captured at the integration-test
   layer the way the GitHub client's can. It cannot — `tenant-access.ts`'s logger is a
   module-level constant, and the only alternative (spying on real stdout) races
   pino's own async writer. The assertion already exists, precisely, at the unit level
   (`tenant-access.test.ts`, Prompt 2's work) — §36 explains the substitution made
   here instead. Worth deciding, if this pattern recurs in a later phase's prompt,
   whether tenant-access's logger should become injectable the way the GitHub client's
   already is, purely to make this class of assertion possible at the integration
   layer — not done here, since it was not asked for and touches Prompt 1/2's file.
2. **Sub-task 3.1/3.3's fixture realism and sanitization requirements conflict on
   exactly one field** (the minted token's value) — resolved in §33, but the prompt
   text does not anticipate the conflict, and a less careful reading could have ended
   with a fixture that trips its own guard, or a guard quietly weakened to let it
   through.
3. **§16's Definition of Done ("a real GitHub App installed... with a repository
   successfully connected end-to-end in staging") was, realistically, never
   achievable by any of this phase's three prompts** — no staging environment has
   existed since Phase 00, and nothing in Phase 02's scope stands it up. Phase 01's
   own decision log already flagged the staging gap; Phase 02 inherits it unchanged
   and this Definition-of-Done item was effectively unmeetable from the first prompt
   onward. Not a flaw introduced by Phase 02, but worth saying plainly rather than
   let a DoD table quietly mark it "done" by proximity to everything else that is.
4. **§18's file list is the only place the frontend's structure is specified**, and it
   names no new route — which is what §38 leans on for "the install entry point lives
   on the project page, not a new settings page." A phase document that wants a
   specific IA decision here should say so; this one left it inferrable but not
   explicit, and a different, equally defensible implementation (a standalone
   `/settings/github` page) was available and rejected only by inference from §18.

## 45. Commits in this prompt

| Commit    | Sub-task                                                        |
| --------- | --------------------------------------------------------------- |
| `32ad3e5` | Sanitized GitHub API fixtures and mocking harness               |
| `5eb4794` | GitHub client fixture tests for caching, retry, and rate limits |
| `cf5d6c8` | Repository connect integration tests                            |
| `f91d73f` | Cross-tenant test extension for repositories                    |
| `9d56cb3` | GitHub App install entry point and installations list           |
| `bbe82d6` | Repository picker, connect dialog, and repository card          |
| `0aa0213` | Setup, deployment, and environment documentation                |

(This closeout commit follows.)

## 46. Acceptance criteria and Definition of Done — the final walk

Nothing below is marked "met" that was not actually observed — see §40/§41 for what
"observed" meant in each case in an environment with no real GitHub App and no staging.

### §15 Acceptance Criteria

| #   | Criterion                                                   | Status              | Basis                                                                                                                                                                       |
| --- | ----------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | User can install the App and see installations listed       | **Met with caveat** | UI built and SSR-verified (empty state, error state, list rendering, the install link's URL structure); the real GitHub install click-through is unverified — no App exists |
| 2   | User can search and select a repository from the picker     | **Met with caveat** | Picker built, typechecked, built, SSR-rendered; interactive search/selection unverified — no browser available this session                                                 |
| 3   | Connecting a valid repository creates `indexStatus=PENDING` | **Met**             | Integration tests (real Postgres) + a live seeded-and-rendered row                                                                                                          |
| 4   | Four invalid-connection cases produce distinct errors       | **Met**             | Integration tests + live curl smoke pass, all four codes/messages confirmed distinct                                                                                        |
| 5   | Same repository, two different projects, independently      | **Met**             | Integration test + cross-tenant test (the stricter cross-_user_ version)                                                                                                    |
| 6   | Same repository twice, same project → 409, no duplicate     | **Met**             | Integration test, including under real concurrency                                                                                                                          |
| 7   | Disconnect sets `connectionStatus=DISCONNECTED`             | **Met**             | Integration tests + a live `DELETE` against the running server                                                                                                              |
| 8   | Installation tokens never persisted or logged               | **Met**             | Unit tests (every success/failure path, both client-layer suites) + integration structural scan (`assertNoTokenPersisted`)                                                  |
| 9   | `repository/index.requested` emitted with correct payload   | **Met**             | Unit test + integration assertion + a real (manually triggered) event observed in the Inngest Dev Server with the exact documented shape                                    |
| 10  | User B cannot view/connect/disconnect User A's repositories | **Met**             | `cross-tenant.test.ts`, extended this prompt, fully green                                                                                                                   |

### §16 Definition of Done

| Item                                                                                                                 | Status                    | Basis                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code: registration doc, `app-auth.ts`, `octokit-factory.ts`, validation service, `connect()`, all routes, connect UI | **Met**                   | All present; UI added this prompt                                                                                                                                                                              |
| DB migrations: `Repository` migrated cleanly; `GithubInstallation` populated on install                              | **Met with caveat**       | Migration clean (`migrate status` confirmed repeatedly); population logic proven correct by tests and direct verification, never by a real GitHub install webhook/sync                                         |
| Tests: all §14 items green, including extended cross-tenant                                                          | **Met with caveat**       | Every automatable item is green (99 integration + 377 unit tests); the manual-verification items requiring real GitHub (§14 steps 1, and the real-GitHub half of 3/4) are blocked, not green — see §40's table |
| Environment variables: GitHub App credentials documented (§19)                                                       | **Met**                   | `.env.example`, `github-app-setup.md`, `deployment.md`                                                                                                                                                         |
| Documentation: permission rationale for customers                                                                    | **Met**                   | `docs/github-app-permissions.md`, verified against the setup runbook this prompt                                                                                                                               |
| Observability: `installationId`/`repositoryId` on every log line                                                     | **Met**                   | Verified against real emitted output (§40), not only against the code                                                                                                                                          |
| Verification: real App, real install, repository connected end-to-end **in staging**                                 | **Requires human action** | No staging environment exists (outstanding since Phase 00); no real App is registered. Cannot be met from this or any prior prompt's environment                                                               |
