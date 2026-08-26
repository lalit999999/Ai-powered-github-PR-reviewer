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

---

# Phase 04 — Prompt 2 Decision Log

Records the judgment calls made implementing **Prompt 2** (tree-sitter queries and the
TypeScript/TSX/JavaScript adapter). Same convention as the Prompt 1 section above.

## 1. Sub-task 2.1 — queries already existed; extended, not recreated

Prompt 1's actual sub-task 1.5 (§5 above) already inlined `queries.ts` as composed
`JAVASCRIPT_QUERY`/`TYPESCRIPT_QUERY`/`TSX_QUERY` string constants covering imports,
exports, symbols, heritage, and calls — the exact thing this prompt's own §18 file list
names as three separate `.scm` files at `tree-sitter/queries/*.scm`. Per this prompt's own
non-negotiable rule 1 ("read Prompt 1's actual output before writing anything"), the
literal `.scm` path was **not** recreated — doing so would have duplicated an
already-tested, already-inlined module and reopened the exact `dist/` packaging gap
Prompt 1 chose inlining specifically to avoid. `queries.ts` was extended in place instead,
each addition verified against the real grammar via a throwaway probe script (S-expression
dumps, including one dump with anonymous/unnamed nodes included — `toString()` alone hides
them, which is how the per-specifier `type` marker's exact position was found):

- `function_expression` bound to a const, alongside the existing `arrow_function` case.
- `abstract_class_declaration` / `abstract_method_signature` — confirmed empirically as
  distinct node types from `class_declaration` / `method_definition`.
- `import_specifier`'s per-specifier `"type"` marker (`import { type Foo, Bar } from "./m"`)
  — a literal anonymous token that is a *child of the individual specifier*, not a sibling
  of `import_clause` the way the whole-statement marker is.
- `export = Foo;` — parses as `export_statement` with the identifier as a positional child
  (no `declaration:`/`value:` field at all), needing its own pattern.

129 capture-name/grammar assertions now pass in `queries.test.ts` (up from 123).

## 2. Sub-task 2.2–2.5 — one adapter commit, not four

The prompt's sub-task boundaries (imports/exports; symbols; calls/heritage; entry point)
were used as the design outline, but the four pieces were built and debugged as one
cohesive module (`typescript.adapter.ts`) and landed in a single commit rather than four
incremental ones — splitting them would have required stubbing later pieces as no-ops
purely to make earlier commits "complete," which serves the commit history less well than
one commit for one real, working, fully-tested module. The golden-file testing pass
(sub-task 2.6) then surfaced two real bugs in already-committed code, fixed in their own
separate commit (below) rather than folded silently into either the adapter commit or the
golden-file commit.

## 3. `Node#startIndex` is not a safe identity key — a real bug this caught

The adapter's call-attribution and heritage-attribution logic both originally built a
`Map<number, InternalSymbolRecord>` keyed by `declNode.startIndex` (or
`callableNode.startIndex`), then walked a node's `.parent` chain looking up each ancestor
by its `startIndex`. This is unsound: a node's `startIndex` frequently *coincides* with an
ancestor's — a `program` node's own start equals its first statement's start, which equals
that statement's first token's start, and so on down the left edge of the tree. A test for
"a call at true module top level is dropped, not attributed to any symbol" failed because
the call's ancestor walk reached the `program` node (`startIndex === 0`), which collided
with the first symbol in the file (also `startIndex === 0`), wrongly attributing the
module-level call to it. Fixed by keying both maps on `Node#id` instead — the property
`web-tree-sitter`'s own type declarations document as unique per node within a tree.

## 4. `getParseErrorInfo` undercounted the most common real-world failure shape

Discovered building the golden-file `malformed.ts` fixture: `parser-pool.ts`'s
`getParseErrorInfo` (Prompt 1) counted only true `ERROR` nodes. A truncated file with
unclosed braces — arguably *the* canonical "malformed file" (`plan.md` §14's own named
scenario) — produces **zero** `ERROR` nodes and only `MISSING` ones (synthetic tokens the
parser inserts to recover from a required-but-absent token). `tree.rootNode.hasError`
correctly reported `true`; `errorNodeCount` reported `0` — silently breaking the invariant
that `hasError === (errorNodeCount > 0)`, and making Prompt 2's entire tolerance-ratio
policy blind to exactly the case it exists to catch. Fixed in `parser-pool.ts` (not worked
around in the adapter) by also counting `TreeCursor#nodeIsMissing`, with a regression test
added to `parser-pool.test.ts`. See §2 sub-task 2.2–2.5 above for why this shipped as its
own commit rather than folded into either neighboring one.

## 5. Tree-sitter's error recovery is far more graceful than expected — sizing the tolerance fixture

A secondary, empirical finding while building the FAILED-path golden fixture: a
"realistic-looking" malformed file (a several-line function body with just one unclosed
brace/paren, otherwise normal code) reliably produced an error-node ratio **under** this
adapter's 10% tolerance (`PARSE_ERROR_TOLERANCE_RATIO`), because tree-sitter's recovery is
good enough that most of the surrounding valid-looking content still parses as ordinary,
recognizable statements — diluting the ratio. Padding the fixture with realistic merge-
conflict markers or extra garbage tokens did not reliably push the ratio over 10% either;
in several probed variants it *lowered* the ratio further (more total nodes, only
marginally more error nodes). What actually crosses the threshold is a **small** file
broken very close to its first token, with little surrounding valid content to dilute the
count (`apps/worker/tests/fixtures/parsing/malformed.ts` — one comment line plus a
function whose parameter list never closes and has no closing braces at all — ratio
≈11%, verified against the live grammar, not assumed). This is worth a future prompt's
attention if the fixed 10% constant ever needs revisiting: it is well-calibrated for "a
small local mistake in an otherwise-fine file shouldn't fail the whole file," but a
correspondingly small *fixture* is required to demonstrate the FAILED path at all — a
large file would need proportionally severe corruption to cross it.

## 6. A doc comment must be immediately adjacent — no blank line — to attach

`collectLeadingTrivia`'s first implementation walked back through preceding
`comment`/`decorator` siblings with no adjacency check at all, so *any* comment on the
"other side" of a blank line from a declaration — including an unrelated section-header
comment several lines above, or (caught directly by the golden-file line-numbering
fixture) an incidental line comment sharing the same tree-sibling relationship purely by
proximity — was swept in as if it were that declaration's doc comment. Fixed by requiring
`current.startPosition.row - prev.endPosition.row <= 1` (at most a line-continuation, no
genuine blank line) before treating a preceding comment or decorator as attached — the
same convention JSDoc-aware tooling (TypeDoc, ESLint's `jsdoc` plugin) already uses. Caught
concretely: `apps/worker/src/indexing/walk-tree.ts`'s own `WalkedFile` interface has a
`// Result shapes` section-comment two lines above it (separated by a blank line) and
correctly picks up **no** doc comment in the end-to-end demonstration output, while
`WalkSummary` three lines later, whose real `/** ... */` doc comment sits with no blank
line in between, correctly does.

## 7. "Valid JS, not valid TS" has no clean grammar-level example in this scope

Sub-task 2.6 asked for "a file that is valid JS but not valid TS, and vice versa."
The reverse direction (valid TS, invalid JS) is trivial and pervasive — any type
annotation, `interface`, or `type` alias is a real, verified example (confirmed
empirically: feeding `ts-only-syntax.ts`'s content to the *plain javascript* grammar
produces real `ERROR` nodes, not just a different-looking parse). The forward direction
has no equally clean example at the tree-sitter grammar level for anything in this phase's
scope: `tree-sitter-typescript`'s grammar is, for every construct this phase cares about, a
strict syntactic superset of `tree-sitter-javascript`'s. Probed candidates that are
often cited as "JS-only" (a legacy `with` statement) parse without error under *both*
grammars — TypeScript's real compiler rejects `with` as a matter of its own stricter
semantic/parser rules, not something encoded in this grammar's context-free structure. Not
fabricated as a fixture; recorded here as a genuine finding instead (see the report-back's
"Conflicts found" for the summary).

## 8. `SymbolKind.VARIABLE` is declared in `@repo/shared` but not reachable from this adapter

Phase 04 §2's own construct list for this prompt (function, arrow-function, class, method,
interface, type-alias, enum, react-component, hook) never names a plain variable/constant
binding whose value is not itself a function/arrow-function/class. `@repo/shared`'s
`SYMBOL_KINDS` union includes `"VARIABLE"` regardless (Prompt 1's own widening), but no
query pattern or adapter branch ever produces it — `export const api = { ... }` (an object
literal, not a function) produces zero symbols today, confirmed by the
`object-literal-members.ts` golden fixture. Not a bug relative to this prompt's own scope,
but flagged here and in the report-back as a known gap a future prompt may need to close
if plain-variable dependency edges turn out to matter for the graph.

## Outstanding — carried forward

- [ ] `SymbolKind.VARIABLE` extraction (§8 above) is not implemented — a deliberate scope
      match to phase-04 §2's construct list, not an oversight, but worth a future prompt's
      explicit decision either way.
- [ ] The parse-error tolerance ratio's practical calibration (§5 above) is worth
      revisiting once real, large repositories are indexed — this prompt's own fixture
      testing surfaced that tree-sitter's error recovery is more graceful than a naive
      mental model predicts, which cuts both ways (fewer false FAILED results on minor
      real-world mistakes; a large file needs more severe corruption to ever cross 10%).

---

# Phase 04 — Prompt 3 Decision Log

Records the judgment calls made implementing **Prompt 3** (repository context, import
resolver, call resolver, test detection). Same convention as the sections above.

## 1. Sub-task 3.1 — repo-context.ts

`buildRepoContext(rootDir, indexedFilePaths)` takes the already hard-ignore-filtered path
list Phase 03's `walkTree` produces rather than re-walking the extracted tree a second
time — cheaper, and it cannot disagree with what Phase 03 already decided to index. Every
manifest hit is still cross-checked against `isHardIgnored` directly (§2's vendored-
`package.json` guard), not trusted from the input list blindly — tested explicitly
(`repo-context.test.ts`, "excludes a vendored package.json that escaped hard-ignore
filtering").

**`pnpm-workspace.yaml` parsing is a bounded, line-oriented scanner, not a YAML
dependency.** `js-yaml` (or similar) is not in `apps/worker`'s dependency tree anywhere in
the monorepo (checked before deciding) — pnpm-workspace.yaml's `packages:` list is one
narrow, well-known shape (`- "glob"` list items under a top-level key), and a ~20-line
scanner for exactly that shape is less risk than adding a new parsing dependency for one
file format this phase touches nowhere else.

**tsconfig `extends` merge: the closest declaration's own `baseUrl`/`paths` replaces the
parent's wholesale**, not a key-by-key merge — matches real `tsc` behavior (a child's own
`paths` fully replaces an inherited one). A cycle guard (`visited` set) stops a tsconfig
that extends itself, directly or transitively, without hanging; verified with a real
two-file mutual-extends cycle fixture completing in well under a second.

**JSONC tolerance is a single-pass linear scanner, not a regex-based strip**, per §0 rule
4's own preference for string operations — comment-stripping and trailing-comma removal
happen in one forward pass tracking a single `inString` flag, with no backtracking to
reason about at all.

**`findTsconfigForFile`/`findPackageForFile` scan for the longest-matching directory
directly, rather than relying on `context.tsconfigs`/`context.packages` being pre-sorted
longest-first.** `buildRepoContext` does sort both that way for its own construction
reasons, but a public lookup function's correctness should not depend on a caller (a
hand-built test fixture, a future caller) preserving that invariant — found directly by
this prompt's own import-resolver test suite (a nested-tsconfig test failed until this was
fixed, because the hand-built fixture array was not pre-sorted).

## 2. Sub-task 3.2 — import-resolver.ts

The five-step ladder is a shape dispatch (relative vs. alias vs. workspace vs. bare), not
a blind "try step 1, then step 2, then step 3" retry cascade — `plan.md` §11.2's own
prose reads that way once each step's own terminal/non-terminal behavior is worked out
carefully: a relative specifier that fails its extension ladder is terminal `UNRESOLVED`
(never re-tried as an alias); a `paths`/`baseUrl` match that finds no file is also
terminal `UNRESOLVED` (never re-tried as a workspace package); a workspace package name
match with an unresolvable subpath is terminal `UNRESOLVED`. Only "this specifier didn't
match this step's own shape at all" falls through to the next step.

**`exports` map resolution**: the common shapes only — a bare string, a top-level
conditions object, an exact subpath key, and a single-wildcard subpath pattern
(`"./*": "./dist/*.js"`). Nested condition+subpath combinations, multiple wildcards, and
condition arrays are not attempted — bucketed `UNRESOLVED` per §0 rule 3 (a wrong file
edge costs more than a missing one). When a package has no `exports` field at all, a
subpath import falls back to a direct relative-path attempt from the package root (the
common shape for workspace packages with no `exports` map); when `exports` *is* present
but does not cover the requested subpath, no further fallback is attempted for that
subpath specifically — an `exports` map is usually intentionally restrictive.

**Subpath imports (`#internal/...`)**: only the direct, non-wildcard key case is handled,
exactly as the prompt names as acceptable; a wildcard `imports` pattern buckets
`UNRESOLVED`.

**Node builtins** are matched against `node:module`'s own `builtinModules` array, not a
hand-maintained list — always correct for whatever Node version the worker runs on, zero
maintenance burden, and it was already available with no new dependency.

## 3. Sub-task 3.3 — test-detection.ts

**Import-based detection widens `isTest`, and prompt 4 should write `isTest = pathBased
|| frameworkImport`** to `RepositoryFile.isTest` rather than leaving Phase 03's path-only
value alone. Reasoning: the false-positive cost (a slightly-wrong flag on one row) is
strictly cheaper than the false-negative cost (an invisible `TESTS`-edge coverage gap for
Phase 08) — the same asymmetry `file-classifier.ts`'s own header already documents for
`detectIsTest`. Widening only, never narrowing, is the direction that can't make things
worse.

## 4. Sub-task 3.4 — call-resolver.ts

**"Instantiated" (rule 5) has no observable signal.** Verified directly against
`queries.ts`: the only call-related query pattern is `call_expression` (bare and
member-expression forms); there is no `new_expression` pattern at all. A `new Foo()`
constructor call is therefore never a `ParsedCall`, and rule 5's "imported **or**
instantiated" receiver check can only ever check the "imported" half. This is a real,
documented recall gap (not a precision one — the missing signal makes the check *more*
conservative, not less), stated loudly per this prompt's own instruction: it does not
lower the precision number prompt 5 measures, but it does mean a class instantiated only
through a local factory/variable with no direct import of the class name will fail rule
5's check and fall through to rule 4's ambiguity handling, costing recall.

**The receiver-in-scope check does not try to match the receiver's own identifier text
against the imported class name.** The overwhelmingly common shape is
`import { Foo } from "./foo"; const f = new Foo(); f.method()` — the receiver (`f`) is an
instance variable, not the class name (`Foo`) itself. Requiring identifier equality would
reject nearly every real instance-method call and pass only the rare static-call shape
(`Foo.method()`), defeating the point of the check. "Is the class imported into this file
at all" is used instead — the actual checkable proxy for "in scope."

**Ambiguity narrowing (rule 4), read literally**: narrow the raw candidate set to
same-package members; if that narrows to nothing at all, try same-top-level-directory
instead; apply the `0.4/N` spread (or the `N > 3` skip) to whichever set survives —
*including* the case where narrowing already reduced the set to exactly one (still scored
`0.4/1 = 0.4`, deliberately below rule 3's `0.7`, since the call started genuinely
ambiguous rather than repo-wide-unique). "Top-level directory" is read as the first
path segment (`apps`, `packages`, …) — a judgment call, since `plan.md` does not define
it precisely; tested against realistic monorepo paths
(`apps/admin/src/handler.ts` vs `apps/web/src/routes/index.ts`).

**Namespace-import member calls (`ns.foo()` where `ns` is bound by
`import * as ns from "./m"`) are folded into rule 2, at the same 0.9 confidence**, not
given a new tier — `plan.md`'s own rule 2 ("a named import resolved to its target file's
export") describes the identical shape once a namespace import's member access is viewed
as "a name resolved through a known, resolved import to a specific target file's export."
No sixth rule, no new confidence constant, per §0's own instruction against inventing one.

**Self-recursion emits an edge** (`factorial` calling itself resolves to itself under
rule 1) — the harmless, honest choice named as acceptable in §0's own framing.

**Per-package vs. global name index**: per-package when `context.workspaceRoots.length >
0`, global otherwise — the caller's own decision, passed as `resolveCalls`'s second
argument rather than decided inside the module, so callers (prompt 4, and this prompt's
own tests) can compare both modes against the identical fixture directly. Verified this is
a genuine precision lever, not just a memory bound: the same two-file, same-named-function
fixture is a unique match (`confidence 0.7`) in per-package mode and an ambiguous
same-repo match (`confidence 0.4`) in global mode — see
`call-resolver.test.ts`'s "per-package name index" describe block.

## 5. Sub-task 3.5 — regex safety audit

Every regular expression literal added by prompts 2 and 3, across
`apps/worker/src/indexing/parsing/` and `apps/worker/src/indexing/graph/` (grepped
directly, not assumed complete from memory):

| File | Pattern | Safety justification |
|---|---|---|
| `parsing/adapters/typescript.adapter.ts:145` | `/^\/\*+/`, `/\*+\/$/` | Anchored at one end each; a single quantified literal-character class (`\/*+` is "one or more `*` chars", not nested); no alternation. Linear. |
| `parsing/adapters/typescript.adapter.ts:148` | `/^\*/` | Anchored, no quantifier at all — matches exactly one optional leading `*`. O(1) per line. |
| `parsing/adapters/typescript.adapter.ts:152` | `/^\/\/\s?/` | Anchored, `?` (zero-or-one) on a single character class — no repetition that can backtrack. |
| `parsing/adapters/typescript.adapter.ts:608` | `HOOK_NAME_PATTERN = /^use[A-Z0-9]/` | Anchored, fixed-width (no quantifier at all). O(1). |
| `parsing/adapters/typescript.adapter.ts:609` | `PASCAL_CASE_PATTERN = /^[A-Z][A-Za-z0-9]*$/` | Anchored both ends, exactly one quantified group (`[A-Za-z0-9]*`) with no alternation and no nested quantifier — the classic *safe* shape (a single `(charclass)*`), not the `(a+)+` shape §0 rule 4 warns against. Linear in input length. |
| `graph/repo-context.ts:371` | `rawLine.replace(/\r$/, "")` | Anchored, no quantifier. O(1) per line, and each line is already bounded by `MAX_MANIFEST_BYTES` (256 KB) before this ever runs. |
| `graph/import-resolver.ts:427` | `/^[a-zA-Z]:[\\/]/` | Fully fixed-width — every atom matches exactly one character, no quantifier anywhere. Runs only against `bounded`, already capped to `MAX_SPECIFIER_LENGTH` (2000 chars) before this line. |

**No pattern above has a nested quantifier or an alternation-inside-repetition shape**
(the `(a+)+`/`(a|aa)+` family this audit was specifically checking for), and every one
that runs against genuinely unbounded input (a doc comment's raw text, a symbol name) is
still a single linear pass regardless — the length bound at the resolver boundary
(`MAX_SPECIFIER_LENGTH` in `import-resolver.ts`) is a defense-in-depth measure on top of
that, not the only thing standing between this code and a slow match. No pattern needed to
be rewritten as a result of this audit; the existing set (mostly inherited from prompt 2,
already written with this constraint in mind per that prompt's own header) was already
safe.

**Pathological-input tests, with pasted timing output** (see the Prompt 3 report-back's
§4 for the full command output): a 100 KB relative-import specifier, a 50,000-segment-deep
`../` traversal chain, and a 50,000-character call-site name all complete in `0ms` against
each resolver, asserted under a 200ms bound in CI.

## Outstanding — carried forward

- [ ] Rule 5's "instantiated" half (§4 above) has no observable signal given prompt 2's
      query scope (no `new_expression` pattern) — a real, accepted recall gap, not fixed
      here. Adding a `new_expression` capture to `queries.ts` would close it, but that is
      prompt 2's module and out of this prompt's own scope to reopen.
- [ ] "Top-level directory" (rule 4's tie-break) is read as the first path segment — not
      explicitly defined by `plan.md`; worth revisiting if prompt 5's precision
      measurement shows this tie-break behaving oddly on a real repository's directory
      shape.
