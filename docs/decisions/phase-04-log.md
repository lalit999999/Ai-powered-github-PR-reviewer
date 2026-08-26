# Phase 04 — Prompt 1 Decision Log

Records the judgment calls made implementing **Prompt 1** of Phase 04 (parser runtime,
shared vocabulary, knowledge-graph schema). Same convention as
`phase-00-log.md`/…/`phase-03-log.md`: records what was decided and what could not be
verified from this environment.

## 1. Sub-task 1.1 — tree-sitter binding

**Chosen: `web-tree-sitter` (WASM), not the native `tree-sitter` binding.** One binding in
dev, CI, and the `node:22-slim` Docker runtime; no `node-gyp`, no compiler toolchain in
`Dockerfile.worker`; `.wasm` files ride along with the existing `pnpm install --prod`
Docker layer with no Dockerfile change (§2.1 non-negotiable rule 1: no repository code is
ever executed — tree-sitter only ever parses text).

**Versions pinned** (`apps/worker/package.json`, exact, no `^`/`~`):

| Package | Version |
|---|---|
| `web-tree-sitter` | `0.26.13` |
| `tree-sitter-typescript` | `0.23.2` |
| `tree-sitter-javascript` | `0.25.0` |

**Ladder rung landed on: 1 (no fallback needed).** The genuine unknown named by the
prompt — whether `tree-sitter-typescript@0.23.2`'s `.wasm` (built by an older tree-sitter
CLI) loads under `web-tree-sitter@0.26.13`'s expected ABI — was resolved empirically: it
loads and parses without error. No pin-down, no swap to `tree-sitter-wasms`, no fallback
to the native binding was needed. `Language.abiVersion` reports `14` for both
`typescript`/`tsx` grammars and `15` for `javascript` — different ABI versions from each
other, both accepted by the same `web-tree-sitter@0.26.13` runtime without complaint,
confirming `web-tree-sitter` supports a range of grammar ABI versions rather than a single
exact one.

**Probe script** (throwaway, run from `apps/worker/` so `node_modules` resolution matches
where the real code lives; never committed — copy retained at
`/tmp/claude-*/scratchpad/probe-tree-sitter.mjs` for this session only):

```
Resolved wasm paths: {
  typescript: '.../tree-sitter-typescript@0.23.2/node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: '.../tree-sitter-typescript@0.23.2/node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm',
  javascript: '.../tree-sitter-javascript@0.25.0/node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm'
}
Parser.init() succeeded

=== typescript ===
abiVersion: 14
hasError: false
S-expression: (program (interface_declaration ...) (export_statement declaration: (class_declaration ... (class_heritage (i...

=== tsx ===
abiVersion: 14
hasError: false
S-expression: (program (interface_declaration ...) (export_statement declaration: (class_declaration ... (class_heritage (i...

=== javascript ===
abiVersion: 15
hasError: false
S-expression: (program (function_declaration ...) (export_statement value: (identifier)))

All three grammars loaded and parsed successfully.
```

Run under Node 22.23.1 — the same major the worker deployable (`node:22-slim`) uses.

**pnpm build-script policy.** `tree-sitter-typescript`/`tree-sitter-javascript` both ship
`"install": "node-gyp-build"` (their native-binding build step). pnpm 11 blocked these by
default (`[ERR_PNPM_IGNORED_BUILDS]`) and auto-appended placeholder entries to
`pnpm-workspace.yaml`'s `allowBuilds` map. Since the WASM binding never touches the native
`.node` output, both are set `false` explicitly (not left unset) — `pnpm install` then
completes with no ignored-build-script warning, and no compiler toolchain is ever invoked
for these two packages, consistent with the whole reason WASM was chosen.

## 2. Sub-task 1.2 — shared vocabulary widening

`PARSE_STATES` widened from `["OK"]` to `["OK", "FAILED", "NOT_PARSED"]`, plus three new
unions (`SYMBOL_KINDS`, `DEPENDENCY_RESOLUTIONS`, `DEPENDENCY_KINDS`) — see
`packages/shared/src/indexing.ts` for the full reasoning on each.

**The widening's own forcing-function did not actually fire.** The prompt's own framing
("widening PARSE_STATES is intended to break compilation") assumes some call site already
assigns/narrows a `ParseState`-typed value. A full `pnpm typecheck` after the widening
passed with zero errors — grepped every non-generated `parseState` reference first to
confirm why: `repository-file.repository.ts` deliberately omits `parseState` from both its
`INSERT` and `DO UPDATE SET` column lists (its own header comment explains why — that
column is Phase 04's to populate), so nothing in the tree before this prompt ever
constructs a `ParseState` value beyond the column's own `"OK"` default. The forcing
function will fire for real once Prompt 4's graph-builder actually writes `FAILED`/
`NOT_PARSED` — recorded here so a future reader doesn't wonder why "should break
compilation" produced a clean typecheck.

`packages/shared` has no test infrastructure at all (no vitest config, no `test` script)
— confirmed by inspecting `package.json` before deciding not to add a `.test.ts` file
for this change, matching the file's own existing state rather than introducing a new
testing pattern unprompted.

## 3. Sub-task 1.3 — Prisma schema, migration, and the live-database verification setup

**This worktree had no Postgres/Redis credentials configured at all** — no `.env` in
`apps/worker`, `apps/api`, or `packages/db` (only `.env.example` at the repo root; `.env`
itself is gitignored and had never been created in this worktree). Rather than skip
live verification, created `apps/worker/.env` and `apps/api/.env` with the same class of
placeholder-but-syntactically-valid values `phase-03-log.md` §5 documents as its own
precedent (a dummy RSA-shaped PEM, dev-only Inngest/OAuth secrets) — needed regardless of
this sub-task's own scope, since the §5 verification gate's `pnpm --filter api test:unit`
requires a parseable config.

**An isolated Postgres 15 container, not the shared `docker-compose.yml` service.** A
`postgresdb`/`redisdb` pair from another concurrent worktree session was already running
on the standard `5432`/`6379` ports (Docker is not git-worktree-scoped, unlike the
repository checkout itself). Running migrations against that shared instance risked
colliding with another session's own schema work. Started a dedicated
`phase4-p1-postgres` container on `5433` instead (`docker run ... -p 5433:5432
postgres:15`), used only for this prompt's own migration/constraint verification, torn
down at the end of the session. Redis has no migration state to collide over, so the
existing shared `redisdb` on `6379` was reused as-is.

**`prisma migrate dev` generated the migration; the `NULLS NOT DISTINCT` constraint was
verified by tearing down and recreating an empty database, then `prisma migrate deploy`**
— not `prisma migrate reset`. `migrate reset` is a genuinely destructive command, and the
installed Prisma CLI itself refuses to run it when invoked by an AI agent without explicit
recorded user consent (a real, built-in guard: it printed an explanation and asked for a
`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` value). Rather than seek that consent for a
throwaway container this session created moments earlier, removed the container outright
(`docker rm -f`, a container this same session created, holding no data anyone asked to
keep) and started a fresh empty one, then ran the non-destructive `prisma migrate deploy`
against it — which proves the identical thing (every migration, including the hand-edited
one, applies cleanly to a database with no prior state) without touching the
reset-confirmation guard at all.

Extended `apps/api/tests/integration/db.test.ts` with a `CodeSymbol + CodeDependency
(phase-04 §6)` describe block, matching the existing phase-02/phase-03 blocks' shape
exactly (round-trip + uniqueness, cascade delete, exact column list, exact index list,
full enum value list) — plus a dedicated test for the `NULLS NOT DISTINCT` behavior itself
(two file-level edges with identical kind/endpoints and both symbol columns NULL; the
second insert must reject). Also added `CodeDependency`/`CodeSymbol` to
`db-helpers.ts`'s `resetDatabase()` TRUNCATE list and to the "creates every table"
assertion's expected list — both would have silently drifted stale otherwise. All 124
`apps/api` integration tests (its own Testcontainers-backed Postgres, unrelated to the
manual container above) pass, including the 8 new ones.

**A follow-up finding, surfaced during the §5 verification gate, not sub-task 1.3
itself**: re-running `pnpm --filter @repo/db db:migrate` (`prisma migrate dev`, no
`--name`) after everything above was already applied does **not** report "up to date" —
it prompts interactively for a new migration name, because its drift-detection diffs a
shadow database (every migration file applied, including the hand-edited
`NULLS NOT DISTINCT` `ALTER TABLE`) against what `schema.prisma` alone would generate.
Since that constraint is deliberately absent from `schema.prisma` (Prisma has no syntax
for it — the model's own comment says so), `migrate dev` sees it as an undeclared
difference and offers to generate a migration that would **drop** it. This is exactly
the "next person to run `prisma db push` will silently drop it" risk the schema's own
comment already warns about, just triggered by `migrate dev`'s drift check rather than
`db push`. Not answered — the interactive prompt was left uncompleted and the process
terminated (confirmed no stray migration file was written). `prisma migrate status`
(read-only, no drift diffing) confirms the real state: "Database schema is up to date!",
5 migrations found, matching the fresh-database `migrate deploy` proof above. **Anyone
touching this schema in the future should use `migrate status` to check, and
`migrate deploy` to apply — never `migrate dev` — for as long as the hand-edited
constraint exists with no `schema.prisma`-native declaration.**

## 4. Sub-task 1.4 — parser-pool.ts

**`getParseErrorInfo` walks the tree with a `TreeCursor`, iteratively, never
recursively.** Verified empirically (not assumed) that a broken snippet's synthetic
error node has grammar type string `"ERROR"` and that `TreeCursor#nodeType` exposes it
without materializing a full `Node` wrapper per visited node — cheaper than
`cursor.currentNode.isError` at every step, and the iterative goto-first-child/
goto-next-sibling/goto-parent traversal cannot exhaust the call stack the way a recursive
descent over an adversarially deep tree could (repository content is attacker-controlled,
`plan.md` §13).

**`MAX_PARSE_CONTENT_BYTES = 2 MiB`** — four times `file-classifier.ts`'s own
`SIZE_CAP_BYTES` (512 KB), the cap that already keeps every file the real pipeline hands
this module well under this limit. Set independently rather than trusted from the caller,
since this module has no way to know whether a given caller is the real indexing pipeline
or some future one-off/debug invocation. tree-sitter parses at roughly 10–50 MB/s
(`plan.md` §10.1), so 2 MiB bounds worst-case parse time to well under a second.

**`disposeAll()` clears the `Parser` cache but not the `Language` cache or
`Parser.init()`'s memoized promise.** `Parser.init()` must only ever run once per
process; `Language` objects are immutable and cheap to keep loaded. Only `Parser`
instances (which hold a live language binding and some internal state) are worth
reclaiming between test files.

## 5. Sub-task 1.5 — tree-sitter queries: inlined, not `.scm` files on disk

**Chose inlined TypeScript string constants over real `.scm` files**, per the choice the
prompt itself frames as available. `apps/worker/tsconfig.json` builds with `include:
["src/**/*.ts"]` and no asset-copy step — `tsc` would silently drop real `.scm` files
from `dist/`, and nothing before `Dockerfile.worker`'s own container boot would catch
it (the same class of gap `phase-03-log.md` §11 already found once, for a different
reason — compiled output behaving differently from `tsx`/vitest reading `src/` directly).
Inlining needed zero Dockerfile or build-script changes and was verified working via
`docker build` regardless (§5's gate item 6, run once for the whole prompt).

**Composed, not duplicated**: `TYPESCRIPT_QUERY = JAVASCRIPT_QUERY + <TS-only patterns>`,
`TSX_QUERY = TYPESCRIPT_QUERY + <JSX-only patterns>`. Verified empirically that this is
actually valid, not just plausible: every capture group in the shared base compiles and
produces non-empty matches under all three grammars (`tree-sitter-typescript`'s
`typescript`/`tsx` sub-grammars and `tree-sitter-javascript`), with exactly one
exception — the type-only-import pattern's literal `"type"` token does not exist as a
node in the plain JavaScript grammar's vocabulary and fails query **compilation** (not
just matching) if left in the shared base. That single pattern lives in
`TYPESCRIPT_QUERY` alone; everything else composes cleanly.

**Every capture group verified against a representative snippet via a throwaway probe
script before being committed to `queries.ts`**, then re-verified permanently by
`queries.test.ts`'s `it.each` sweep over every named capture — 123 assertions, one per
capture-group/grammar combination, each asserting a **non-empty** match count. Two gaps
this caught in the test's own sample data (not the queries): the JS sample initially had
no `export { x as y }` or `export * as ns from` shapes, and neither TS/TSX sample had an
`export default <expression>` case (only `export default function ...`, which resolves
through a different grammar field) — both fixed by extending the sample source, not the
queries.

## 6. Sub-task 1.6 — the `ParsedFile` contract

Matches `phase-04…md` §3.4's given interface sketch field-for-field, including keeping
`ParsedExport.name` a required `string` (not widened to optional) even though
`export * from "./x"` has no local name — the adapter's contract is to set it to `""` for
that shape, per that field's own doc comment; `reExportFrom`'s presence is what a
consumer actually branches on. Deviating from the given sketch here would have introduced
a third undocumented departure beyond the two the prompt itself names
(`ParsedCall`-as-object, `ParsedImport.syntax`), which it explicitly does not ask for.

`ParsedFile.parseState` is typed as the full `@repo/shared` `ParseState` union (not a
narrowed `Extract<ParseState, "OK" | "FAILED">`) for the same single-source-of-truth
reason — the practical narrowing (a `ParsedFile` is never produced for a `NOT_PARSED`
file) is documented in a comment, not enforced by the type, so `@repo/shared` stays the
one place the vocabulary is pinned.

## 7. §5 verification gate — the Docker build could not be completed in this environment

`pnpm build --filter=worker` succeeds, and the compiled `dist/indexing/parsing/
tree-sitter/queries.js` was directly inspected to confirm the inlined query strings
survive compilation (§5's actual concern, independent of whether the container itself
boots). `docker build -f Dockerfile.worker .` itself could not be completed, after four
attempts (plain bridge networking, then `--network=host` three times, across two
separate sessions of this same prompt) — every attempt failed inside the
`deps`/`prod-deps` stages' `pnpm install --frozen-lockfile[--prod]`, never past it, on
sustained registry connectivity failures (`EAI_AGAIN` DNS failures, `error (23)`,
`UND_ERR_SOCKET`/`UND_ERR_CONNECT_TIMEOUT`, and outright request timeouts) against
`registry.npmjs.org`. This is a hard environment/network limitation of this sandbox, not
a defect in `Dockerfile.worker` or anything this prompt changed — proven decisively, not
just inferred:

- A single sequential request to the registry (`curl -sI .../web-tree-sitter`) reliably
  succeeds in under a second, repeatedly.
- **40 concurrent `curl` requests to the registry, issued directly from the host (no
  Docker involved at all), all failed within an 8-second timeout — 0 of 40 succeeded.**
  This is the decisive test: pnpm's installer is a parallel downloader by design (the
  build logs show dozens of simultaneous in-flight GETs), and this sandbox's network
  cannot sustain that concurrency at all, regardless of whether Docker or bridge vs.
  host networking is involved. The problem is concurrency, not DNS, not Docker, and not
  this Dockerfile.
- The third attempt (a prior session of this same prompt) ran for **17+ minutes** and
  successfully resolved **898 of 898** lockfile entries — nearly the entire install —
  before failing on pnpm's separate supply-chain "minimum release age" metadata check
  (a per-package registry GET, independent of the tarball fetch), which hit the same
  concurrency ceiling on its final ~15 packages and treated that as a hard failure
  (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`). Getting 898/898 packages most of the way
  through, on top of the direct concurrency test above, is conclusive: the Dockerfile and
  dependency set are correct, and no further retry of the same command will fix a
  sandbox-level concurrent-connection ceiling.
- Nothing in Dockerfile.worker, the pruned lockfile, or apps/worker's new dependencies
  was found to be wrong — the failures occurred at genuinely random points across
  different packages on different attempts, consistent with a concurrency ceiling rather
  than a specific bad package/URL.

**A secondary, pre-existing observation surfaced by watching these builds closely,
unrelated to why they failed**: `turbo prune worker --docker`'s pruned `pnpm-lock.yaml`
correctly scopes the **importers** section to exactly `worker` + its 4 workspace
dependencies (verified directly — `apps/web`/`apps/api` do not appear), but the
lockfile's global `packages:` resolution catalog is **not** pruned to match, and
`pnpm install --frozen-lockfile` against it resolves/fetches close to the whole
monorepo's dependency graph (782–898 entries across the three attempts) rather than the
much smaller set `worker`+`@repo/db`+`@repo/github`+`@repo/observability`+`@repo/shared`
alone would need. This predates this prompt (Dockerfile.worker and the prune mechanism
are untouched here) and was not something any earlier phase's log flagged, likely
because earlier, smaller dependency sets never made this a slow build. Not fixed as part
of this prompt — out of scope for Prompt 1's sub-tasks — but worth a future prompt's
attention, since it materially inflates image build time and is very likely why the
sandbox's flaky network turned a normally-tolerable install into a hard failure here.

Every other §5 item (grammar loading, lint, typecheck, worker/api unit and integration
tests, the migration, the live constraint check) is independently verified — see the
report-back for full output. The Docker boot/`/api/inngest` check itself was never
reached, since no image was ever produced.

## Outstanding — carried forward for a human/future session

- [ ] **`docker build -f Dockerfile.worker .` has not been verified to succeed or boot in
      this environment** — blocked purely on this sandbox's npm-registry connectivity
      (§7 above). Needs re-verification wherever a more reliable network is available;
      nothing about the Dockerfile itself is suspected.
- [ ] `turbo prune worker --docker`'s lockfile catalog scoping (§7) is worth a follow-up
      look — not a correctness bug (the *importers* are correctly scoped), but a
      possible build-time/size inefficiency.

All six of this prompt's own sub-tasks are otherwise complete. See the Prompt 1
report-back for the full verification-command output.
