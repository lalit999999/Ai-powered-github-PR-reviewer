# GitHub API fixtures — provenance

**These are schema-derived, not recorded.** `plan.md` §40.3 asks for fixtures that are
"recorded real responses (sanitized)". This environment has no real GitHub App, no real
installation, and no real repository (`docs/decisions/phase-02-log.md` §14/§29), so
there was nothing to record from. That is stated here plainly rather than left for
someone to discover later — see phase-02 Prompt 3 §0 rule 4.

## How these were built

Each file was hand-written against GitHub's **documented** REST response shapes for the
four endpoints this phase calls:

- `GET /user/installations`
- `GET /installation/repositories`
- `GET /repos/{owner}/{repo}`
- `POST /app/installations/{installation_id}/access_tokens`

plus `GET /repos/{owner}/{repo}/branches/{branch}`, used only by the ambiguous-empty-repo
probe (`repository-validation.service`'s step 4 — see `docs/decisions/phase-02-log.md`
§23).

Every field the code under test actually reads is present, with a realistic value:
real-magnitude ids (GitHub App installation ids and repository ids are large, so these
are too — `1296269` is GitHub's own long-standing API-docs example repo id, kept
deliberately since it is already the convention this codebase's unit tests use), the
real header names in the casing GitHub sends them (`x-ratelimit-remaining`,
`x-ratelimit-reset`, `etag`), and error bodies shaped like GitHub's actual error
envelope (`message` + `documentation_url`). Extra fields beyond what the code reads are
included where they make a fixture read as a real response rather than a stub (owner
type, timestamps, permissions) — this is a judgment call, not an attempt at completeness;
these are not full recordings and were never meant to be.

## Format

Every fixture is `{ "status": number, "headers": { ... }, "body": <any> }` — a direct
map onto what `nock(...).get(path).reply(status, body, headers)` needs, and onto what a
raw `fetch()` response looks like when read back (`GithubHttpResponse` in
`src/github/client/app-auth.ts`). One file, one HTTP response.

Two fields are `"__PLACEHOLDER__"` tokens substituted at load time (`loadFixture` in
`src/github/github-fixtures.test.ts`), because their real values have to be relative to
whenever the test actually runs, not a value baked in once:

- `access-token-403-rate-limited.json` / `repo-403-rate-limited.json`'s
  `x-ratelimit-reset` header — `__RATE_LIMIT_RESET__`.
- `access-token-success.json`'s `expires_at` — `__EXPIRES_AT__`. This one was a real bug
  caught while building this harness, not a preemptive nicety: a hardcoded
  `"2026-01-01T13:00:00Z"` was correct on the day this fixture was written and silently
  wrong the next time the suite ran against a later real clock — `effectiveTtlSeconds`
  saw an already-"expired" token, cached it with a `0` TTL, and the very next
  cache-reuse assertion failed because there was nothing to reuse. A static timestamp in
  a fixture that gets compared against `Date.now()` is a landmine with a fuse measured in
  months; the placeholder is the fix, not a workaround.

## Sanitization

No file here contains anything shaped like a real credential. In particular,
`access-token-success.json`'s `token` field is **deliberately not** `ghs_`-prefixed the
way a real GitHub installation token is — a realistic prefix followed by a fixture
placeholder is exactly the shape the sanitization check
(`github-fixtures.test.ts`'s `"fixtures never contain anything shaped like a real
credential"` suite) exists to catch, and a hand-written fixture tripping its own guard
would either have to weaken the guard or carry a silent exemption. Using an unmistakably
fake token string (`FIXTURE-INSTALLATION-TOKEN-DO-NOT-USE`) avoids the conflict entirely:
the code under test only cares that `body.token` is a non-empty string, never its shape.

No fixture contains a real private repository name (`octocat/hello-world` is GitHub's own
public documentation example; `acme-corp/*` and `someuser/*` are invented placeholders),
a real user email, or a private key.

## What a human must do to replace these with real recordings

Once a real GitHub App exists (`docs/github-app-setup.md`) and is installed on a test
account with a few repositories (§14/§29 "Outstanding — requires human action"):

1. Record each endpoint's actual response — e.g. with `curl -i` against
   `api.github.com` using a real installation token, or by temporarily logging
   `octokit-factory`'s response in a local run.
2. Sanitize: replace the real installation id, repository ids/names, owner login, and
   the token value with clearly-fake stand-ins, keeping the response shape and header
   casing exactly as GitHub sent them.
3. Overwrite the corresponding file here — the loader and every test in
   `github-fixtures.test.ts` are shape-driven, not content-driven, so a faithful
   sanitized recording should drop in without changing the tests.
4. Re-run `pnpm test:unit` and confirm nothing needed to change. If something did, that
   is itself the signal that this schema-derived version had drifted from what GitHub
   actually returns — the interesting outcome this whole exercise exists to catch.
