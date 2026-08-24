# Phase 02 — Decision Log

Records the judgment calls made implementing Phase 02 **Prompt 1** (foundation + GitHub
App client): the schema, the configuration, the Redis-backed token cache, and the GitHub
client. Prompts 2 and 3 build the services, routes, and UI on top of this; entries here
are binding for that work.

Same convention as `phase-00-log.md` / `phase-01-log.md`: this file records what was
decided *and* what could not be verified from this environment. §12 is the honest list.

## 0. Inherited baseline (verified before writing any Phase 02 code)

Every command run against the tree as inherited, before a single line was changed:

| Command | Result |
|---|---|
| `pnpm install` | Clean — "Already up to date", 6 workspace projects |
| `pnpm db:generate` | Prisma Client 7.9.1 generated to `packages/db/src/generated` |
| `pnpm lint` | Pass, 0 errors (`turbo lint` + the root boundary/no-console config) |
| `pnpm typecheck` | Pass — 3 tasks (`api`, `web`, `worker`) |
| `pnpm test:unit` | Pass — **10 files, 94 tests** |
| `pnpm test:integration` | Pass — **6 files, 58 tests** (Testcontainers Postgres) |
| `pnpm build` | Pass — 3 tasks |
| `prisma migrate status` | "Database schema is up to date!", 2 migrations found |

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

| Package | Version | Why this one |
|---|---|---|
| `ioredis` | 6.0.0 | The installation-token cache client — see §6 for the choice against `redis` |
| `@octokit/auth-app` | 8.3.0 | App JWT signing. Preferred over hand-rolling RS256, per the prompt |
| `@octokit/core` | 7.0.7 | The Octokit base the plugins target. `octokit` (the batteries-included meta-package) would have pulled `plugin-rest-endpoint-methods`, `plugin-paginate-rest`, and the GraphQL client for a client that makes four REST calls |
| `@octokit/plugin-retry` | 8.1.1 | 5xx/network retry. Peer-requires `@octokit/core` ^7 |
| `@octokit/plugin-throttling` | 11.0.5 | Primary + secondary rate limits |
| `@octokit/request-error` | 7.1.1 | Direct dependency so error narrowing does not rely on a transitive install |
| `@octokit/types` | 15.0.2 (dev) | `EndpointDefaults` etc. for the handler signatures. Dev-only: types erase at build |

Transitively relevant, verified because their behavior is load-bearing here:

| Package | Version | What was verified |
|---|---|---|
| `universal-github-app-jwt` | 2.2.2 | `auth-app`'s signer. Backdates `iat` by 30s, sets `exp` to iat+10min (GitHub's maximum), and — in `lib/crypto-node.js` — converts a **PKCS#1** key to PKCS#8 before handing it to WebCrypto. That is why the config accepts GitHub's default `.pem` unchanged |
| `@octokit/request` | 10.0.15 | `fetch-wrapper.js` **throws** a `RequestError` on `304` rather than returning one. The ETag plugin is built around that fact (§9) |
| `before-after-hook` | 4.0.0 | `register.js`'s reduce applies registered wraps outward-in: the **last** registered wrap is outermost. Plugin order in `octokit-factory.ts` depends on this |
| `bottleneck` | 2.19.5 | Pulled by `plugin-throttling`. Its `light.js` build, no Redis clustering configured |

Two API facts worth writing down because getting them from memory would have been wrong:

- **`@octokit/plugin-throttling` throws at construction** unless *both* `onRateLimit` and
  `onSecondaryRateLimit` are functions (`dist-src/index.js`). They are not optional.
- **`ioredis@6` has no default export usable from ESM.** `import Redis from "ioredis"`
  type-checks as a namespace and is not constructable under `NodeNext`; the named
  `import { Redis } from "ioredis"` is correct. Verified both at the type level and by
  running it under Node 22.

## 2. Private-key encoding — base64, checked at boot

`GITHUB_APP_PRIVATE_KEY` is **base64 of the whole `.pem` file**. One line, no escaping
rules, survives every `.env` loader and secret store unchanged. `config.ts` decodes it
and refuses to boot unless the result carries a `-----BEGIN [RSA ]PRIVATE KEY-----`
header *and* a matching footer.

Chosen over literal `\n` escapes because escape handling is where this actually breaks in
practice: a value can survive one env loader and be mangled by the next, and the failure
then surfaces at the first GitHub call rather than at boot.

A value that already looks like a PEM is passed through unchanged. dotenv supports
multi-line double-quoted values, so pasting the file works locally, and rejecting it
would be hostile for no security gain. This is a local-dev convenience, not a second
supported deployment encoding — `docs/github-app-setup.md` documents base64 as *the*
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
the identical metadata call this phase already makes for the size cap, so *not* storing
it would mean re-fetching to answer "how big is this repo?"; and Phase 06 needs
`webhookId` to manage the webhook it registers. Nullable because Prompt 1 writes neither
and a non-null column would force a fabricated default.

*(Note: `sizeBytes` maps to Postgres `INTEGER`. GitHub reports repository size in KB, and
the connect-time cap is ~500 MB, so int32 has roughly six orders of magnitude of
headroom. The column name says bytes and the source is KB — whichever unit Prompt 2
stores, it must be consistent, and this note exists so that choice is made deliberately.)*

**`installationId` stays a plain `BigInt`, not a foreign key.** `plan.md` §24.2 calls it
a `fk`, and a real relation *is* possible — `GithubInstallation.installationId` already
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
`db.test.ts` asserts the index is *absent*, so the omission reads as a decision rather
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

If this is ever revisited, the argument *for* an enum is that `ACCESS_LOST` is a state
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
- `get()` consults the fallback on a Redis *miss* too, so a write made during an outage
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
into a success *before* the retry plugin's error hook sees it. Registered outermost,
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
`apps/api/src/modules/**` are deliberately *not* in Rule A's `files` list, so they may
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

**A bare `key` is deliberately NOT redacted.** The token cache logs its *cache key* by
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
*exchange* is not, even though `auth-app` offers it — because `auth-app` keeps its own
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
`app-auth.test.ts` *additionally* pins the constant's value and asserts it leaves ≥10
minutes of headroom under GitHub's hour. Temporarily setting it to `60 * 60` was run and
fails 4 tests — the check the prompt asks for.

**Retry taxonomy** (phase-02 §12), all asserted:
- 5xx or network error → 3 attempts total, backoff 250ms then 500ms, then a clean
  `ServiceUnavailableError`. Never hangs.
- **401 → no retry**, `GithubAccessRevokedError`. A revoked installation does not become
  un-revoked by asking again.
- **403/429 *with* rate-limit headers → `GithubRateLimitError`**, never revocation.
  Getting this backwards would mark healthy repositories `ACCESS_LOST` every time the App
  got busy.
- 403/404 *without* rate-limit headers → suspended or gone → `GithubAccessRevokedError`.
- Any other 4xx → no retry (a request we got wrong does not improve on repetition).
- A 2xx with no `token` field → `ServiceUnavailableError`, not revocation: it means we do
  not understand the response, which is a bug rather than a permission state.

**Two new `AppError` subclasses**, in `lib/errors.ts` beside the others (so Prompt 2's
service layer imports them without reaching into the GitHub tree, which Rule A now
guards). `GithubAccessRevokedError` is 403; `GithubRateLimitError` is **503, not 429** —
the exhausted budget is *ours* against GitHub, not the caller's against this API, so
"you are sending too many requests" would be a false statement to the user.
`details.retryAfterSeconds` carries the wait.

**A rate-limited *mint* fails fast rather than sleeping.** GitHub's primary limit resets
on a fixed hourly window, so `x-ratelimit-reset` can be an hour out. Sleeping that long
inside a user-facing request holds the connection open for nothing. Ordinary API calls go
through `octokit-factory`, which *does* schedule short waits — capped at
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
  name nor the commenting was changed. *This means nothing in this phase has been
  verified by CI — only locally.*
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
done, and none of it *can* be done from this environment:

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

What *has* been verified against something real: Redis (the `RedisTokenCache` was
exercised against the live `redis:7-alpine` container — set with EX, read back, TTL
confirmed at 5s, delete), Postgres (the migration and every `Repository` schema assertion
ran against a real database), and the boot path (`apps/api` starts with the documented
values and answers `GET /api/health` with 200; it refuses to start, naming the variable,
when a Phase 02 variable is missing or the private key is mangled).

## 15. Commits in this prompt

| Commit | Sub-task |
|---|---|
| `cc153d6` | Redis service, GitHub App env vars, config validation |
| `6f0242e` | `Repository` model, `IndexStatus` enum, migration |
| `0df5035` | `TokenCache` abstraction, Redis + in-memory backends |
| `967929d` | `app-auth` token minting with caching and retry |
| `59b3f03` | Octokit factory: retry, rate limiting, ETag caching |
| `278c6ab` | GitHub App registration + permission rationale docs |

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
