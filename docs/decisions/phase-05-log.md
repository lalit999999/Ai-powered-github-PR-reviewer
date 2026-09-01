# Phase 05 — Prompt 1 Decision Log

Records the judgment calls made implementing **Prompt 1** of Phase 05 (repair `main`,
provision pgvector, land the schema). Same convention as `phase-00-log.md`/…/
`phase-04-log.md`: records what was decided and what could not be verified from this
environment.

## 1. Why `main` was broken, and the union-merge resolution

At merge commit `fd45f9b`, seventeen files carried unresolved `<<<<<<<`/`=======`/
`>>>>>>>` markers from the Phase 04 → Phase 06 merge — the repository did not compile,
lint, or pass `prisma validate`. **Root cause**: the CI workflow lived at
`.github/workflow/ci.yml` (singular `workflow`), which GitHub Actions never reads, so
nothing checked the merge before it landed. Fixing the directory name (sub-task 1.3) is
the single highest-leverage change in this phase — it is the reason this class of failure
reached `main` at all.

Every conflict was resolved as the union of both sides — never `--ours`/`--theirs` — since
`HEAD` (Phase 04: knowledge endpoint, `KnowledgePanel`, `CodeSymbol`/`CodeDependency`) and
`main` (Phase 06: webhook-test endpoint, `WebhookStatusPanel`, `WebhookEvent`/
`PullRequest`, ESLint Rule D, `checkRateLimit`'s `windowSeconds` parameter) both shipped
and both had to survive:

| File                                                                                      | Resolution                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eslint.config.mjs`                                                                       | Kept Rule D (main-only block); added the missing trailing comma.                                                                                                                                                                         |
| `packages/shared/src/index.ts`                                                            | Kept `PULL_REQUEST_REVIEW_REQUESTED`, alphabetically placed.                                                                                                                                                                             |
| `apps/worker/src/app.ts`                                                                  | Kept all three functions in the `serve()` array.                                                                                                                                                                                         |
| `apps/api/src/lib/rate-limit.ts`                                                          | Took `main`'s side entirely — `windowSeconds` parameter, bucket arithmetic, `retryAfterSeconds` fallback. `DEFAULT_WINDOW_SECONDS` was already declared in the merged file.                                                              |
| `apps/api/src/controllers/repositories.controller.ts`                                     | Kept both handlers (`getKnowledge`, `getRecentWebhookDeliveries`) with their full doc comments.                                                                                                                                          |
| `apps/api/src/routes/repositories.routes.ts`                                              | Imported and registered both handlers alongside the four pre-existing routes.                                                                                                                                                            |
| `apps/api/src/modules/repositories/repository.service.test.ts`                            | Kept both `vi.mock` calls and both dynamic imports.                                                                                                                                                                                      |
| `apps/api/src/inngest/emit.test.ts`                                                       | Destructured all three emit functions.                                                                                                                                                                                                   |
| `apps/api/tests/integration/db-helpers.ts`, `apps/worker/tests/integration/db-helpers.ts` | `TRUNCATE` list is the union of both sides.                                                                                                                                                                                              |
| `apps/api/tests/integration/db.test.ts`                                                   | Rewrote the test name to name all four phases' tables; the assertion body already checked the full union.                                                                                                                                |
| `apps/web/src/lib/api.ts`                                                                 | Kept both type blocks (`RepositoryKnowledge`/friends, `WebhookDelivery`).                                                                                                                                                                |
| `apps/web/src/components/repository/repository-card.tsx`                                  | Imported both panels; rendered both inside `<CardContent className="flex flex-col gap-4">`.                                                                                                                                              |
| `docs/github-app-setup.md`                                                                | Took `main`'s more accurate per-event notes for both tables; no row was present only on the `HEAD` side.                                                                                                                                 |
| `packages/db/src/generated/**` (3 files, 30 conflict blocks total)                        | Not hand-merged — conflict markers were mechanically stripped (kept the first/`HEAD` side of each block) purely to get the tree buildable, then fully overwritten by `prisma generate` in sub-task 1.4 once the schema itself was fixed. |

No conflict required a judgment call beyond the prompt's explicit per-file instructions.

**One additional break found and fixed, not itself a merge conflict**:
`packages/db/prisma/schema.prisma`'s `datasource db` block still declared
`url = env("DATABASE_URL")` inline. This repository is on Prisma ORM 7, which moved
datasource URL resolution to `prisma.config.ts` (already present and correct) and
rejects the inline schema-level `url` property with `P1012`. This was blocking
`prisma validate` outright — independent of anything the merge touched — so the line was
removed as part of sub-task 1.2, before the back-relations fix, since neither could be
verified without it.

## 2. pgvector image choice and measured extension version

`docker-compose.yml`'s `postgresdb` service and both Testcontainers `global-setup.ts`
files now run `pgvector/pgvector:pg16` instead of plain `postgres:15`. Measured against a
freshly provisioned container (`docker compose down -v && docker compose up -d postgresdb`,
then `CREATE EXTENSION IF NOT EXISTS vector; SELECT extversion ...`):

```
extversion
------------
0.8.6
```

Well above the `halfvec` floor of 0.7.0 (HNSW alone would only need 0.5.0).

## 3. The nullable-`embedding` departure from §6

§6's own Prisma block declares `embedding halfvec(1024) NOT NULL`. This is
self-contradictory with §4 Reliability/§8 Failure behavior, which require a repository to
be able to reach `indexStatus=PARTIAL` with `chunksEmbedded < total` and be resumable
later — a `CodeChunk` row must therefore be able to exist with `content` and without a
vector. A `NOT NULL` column would force "embed first, insert second," which would force
the resume sweeper to re-download and re-chunk the whole repository from GitHub, because
`indexer.service.ts`'s `onExtracted` callback deletes the extracted tarball in a `finally`
the instant the callback returns (§2.6). **Resolution**: `embedding` is nullable, with a
partial index (`CodeChunk_pending_embedding_idx`, `WHERE embedding IS NULL`) so the resume
sweeper's scan of the unembedded remainder is cheap rather than a sequential scan. HNSW
indexes skip `NULL` rows natively, so search correctness is unaffected.

`vector-schema.test.ts`'s second test is the guard on this decision — it asserts
`is_nullable = 'YES'` on `information_schema.columns` specifically so a future "fix" to
`NOT NULL` fails a test with an explanation, rather than silently reintroducing the
resume-sweeper problem this decision exists to avoid.

## 4. The dropped `projectId`

§6 declares `CodeChunk.projectId String`, but with no relation, no index, and no reader
anywhere in the phase. Every sibling indexing table (`RepositoryFile`, `CodeSymbol`,
`CodeDependency`) keys on `repositoryId` alone, and `requireTenantAccess` already resolves
a repository up to its project in one query (the established chokepoint,
`apps/api/src/lib/auth/tenant-access.ts`). A denormalized `projectId` with no foreign key
is a column that can silently disagree with `Repository.projectId` and that nothing would
ever notice. **Resolution**: dropped. Tenant isolation is `repositoryId`, enforced by the
`VectorStore` interface's type signature in Prompt 2.

## 5. The `Unsupported(...)` technique

Prisma's schema language cannot express `halfvec`, a `GENERATED ALWAYS AS ... STORED`
column, or HNSW/GIN index methods. Phase 04 already learned (`CodeDependency`'s own model
comment, `docs/decisions/phase-04-log.md`) that DDL invisible to `schema.prisma` is DDL
`prisma migrate dev`'s shadow-database drift check proposes to **drop** on the next
`migrate dev` invocation — confirmed again directly in this phase: running
`prisma migrate dev --name vector_search --create-only` against the fixed schema produced
a migration that opened with `DROP INDEX "CodeDependency_edge_identity_key";`, exactly the
hazard that model's own comment warns about, because that constraint's `NULLS NOT
DISTINCT` SQL has no `@@unique` declaration in `schema.prisma` for the drift check to
reconcile against. That line was removed by hand before the migration was ever applied
(sub-task 1.6); `CodeDependency_edge_identity_key`'s survival is verified directly via
`psql` in this phase's own report, not just assumed.

`embedding Unsupported("halfvec(1024)")?` and `tsv Unsupported("tsvector")?` are declared
as **optional** `Unsupported` fields on both `CodeChunk` and `EmbeddingCache` — a required
`Unsupported` field makes the whole model uncreatable through Prisma Client, while an
optional one is simply excluded from the typed API. That is exactly what is wanted: every
read and write of both columns goes through raw SQL in the pgvector `VectorStore`
(Prompt 2), never through Prisma's query builder.

One additional wrinkle not mentioned in §6: Prisma's own generated `CREATE TABLE` for
`CodeChunk` emitted `"tsv" tsvector` as a **plain, non-generated** column (since
`Unsupported(...)` carries no information about `GENERATED ALWAYS AS`). Left as-is, the
subsequent hand-written `ALTER TABLE "CodeChunk" ADD COLUMN "tsv" tsvector GENERATED
ALWAYS AS (...) STORED` would fail with "column already exists." The plain column
declaration was removed from the generated `CREATE TABLE` block by hand, leaving the
generated-column definition to the hand-written `ALTER TABLE` later in the same file.

## 6. The two-argument `to_tsvector` immutability requirement

`to_tsvector('english', "content")` — the two-argument form with an explicit `regconfig`
literal — is `IMMUTABLE` and legal in a generated column. The one-argument
`to_tsvector("content")` is only `STABLE` (it reads `default_text_search_config` from
session state) and Postgres rejects it in a `GENERATED ALWAYS AS` expression. Verified
directly: `\d+ "CodeChunk"` reports the column's `generation_expression` as
`to_tsvector('english'::regconfig, content)`, and `information_schema.columns` reports
`is_generated = 'ALWAYS'` for it.

## 7. The global `EmbeddingCache` and its cross-tenant caveat

`EmbeddingCache` is keyed on `contentHash` alone, with no `repositoryId` — shared
**globally** across every repository this system indexes, not scoped per repository.
Boilerplate and vendored code repeat constantly across unrelated codebases, and a shared
cache is free deduplication worth an expected 15–40% hit rate (`plan.md` §37.3 item 6).
The table deliberately holds no source content and no repository reference — only the
hash, the model, the vector, and usage counters (`hits`, `lastUsedAt`) — so a cache hit is
only reachable by a caller who already possesses the exact bytes that produced the hash.
That is why this is not treated as a cross-tenant read path for source code: nothing about
hitting the cache reveals _what_ the cached content is, only that some tenant, at some
point, embedded content with this exact hash.

**Honest caveat, not resolved by that argument**: `hits` is a weak existence oracle for a
caller who can already guess exact file contents — e.g., a caller who suspects a specific
proprietary snippet exists somewhere in the corpus could hash a guess and observe whether
`hits` increments faster than expected, or whether a lookup path (once Prompt 2 builds
one) reports a hit at all. This is a real, narrow information leak, bounded by needing to
already possess the exact bytes (a hash collision search is not practical); it is not
eliminated by this design, only bounded. Recorded here rather than silently accepted —
whoever builds the read path in Prompt 2 should not assume the cache is a zero-leak
surface just because it holds no plaintext.

## 8. What could not be verified from this environment

- **Neon** (the `DATABASE_URL` in `packages/db/.env`) was not used to verify the
  migration — its migration history has diverged from what is committed in this
  repository (`prisma migrate status` against it reports a local common-ancestor of
  `null`, i.e., a stale/unrelated database, not a corrupted one this phase caused). All
  schema verification in this phase (sub-tasks 1.2's `migrate status`, 1.6's `migrate
deploy`, 1.8's integration suite) ran against the local `pgvector/pgvector:pg16`
  container instead — `docker compose down -v && docker compose up -d postgresdb` gives a
  genuinely fresh database every time. Whether Neon's own migration history should be
  reset to match this repository is a decision for whoever owns that database, not this
  phase.
- `apps/api/src/lib/boundaries.test.ts`'s "Rule A" case is flaky in this environment on a
  cold run — the first `ESLint` instance it constructs (a real, full `ESLint` program
  load against `eslint.config.mjs`) intermittently exceeds the file's 5,000ms test
  timeout on first invocation, then reliably completes in under 4,000ms on every
  subsequent run in the same process/session. Not introduced by this phase — the test
  itself, its timeout, and the `ESLint` construction it does are all unchanged Phase 00
  work — but worth recording since it surfaced repeatedly while re-running the full gate
  in this session. Not fixed here since it was pre-existing.
- `pnpm test:integration`'s full combined run (`apps/api` + `apps/worker`) was exercised
  successfully in this session (Docker/Testcontainers available), including the
  10,000-file-shaped real-repo suites; nothing in this phase's own scope could not be
  run end-to-end.

## Prompt 2 — `VectorStore` interface, pgvector store, hybrid scoring

Records the judgment calls made implementing Prompt 2 of Phase 05: the `VectorStore`
interface, the pgvector-backed implementation (`upsert`, `search`, `hybridSearch`,
`deleteByFilePaths`, `deleteByRepository`), and the hybrid scoring formula as a pure
module.

### The `halfvec` binding technique

pgvector's wire format for a vector is the string literal `'[0.1,0.2,...]'`, not a JS
`number[]` bound as a Postgres array. Every write and read binds the serialized string
as a parameter and casts it statically: `${literal}::halfvec(1024)`, where `literal =
`[${vector.join(",")}]``. A `null` embedding binds as `NULL::halfvec(1024)` — the
explicit cast matters in a multi-row `VALUES` list where the first row happens to be
null, so Postgres can still infer the column's type for every other row.

`SET LOCAL hnsw.ef_search = ...` was verified **not** to accept a bind parameter —
`prisma.$executeRaw`'s tagged template with a parameter in that position fails with
`syntax error at or near "$1"` (Postgres's `SET` grammar only accepts a literal
constant). The fixed, code-controlled `HNSW_EF_SEARCH_FILTERED` constant is spliced in
via `Prisma.raw(String(HNSW_EF_SEARCH_FILTERED))` instead — never anything
request-derived, so this does not reopen the string-interpolation rule (`plan.md`
§35.11) it otherwise upholds everywhere else.

### `String[]` binding — verified, not assumed

`symbols`/`imports` (`text[]` columns) were tested directly against the `PrismaPg`
driver adapter: a plain JS `string[]` parameter binds cleanly to a `text[]` column with
**no explicit cast needed**, verified by a real insert-and-read-back
(`apps/worker/tests/integration/vector-store.test.ts`'s "round-trips symbols/imports
text[] columns" test). This works because the `INSERT`'s own explicit column list
already tells Postgres what type to expect at that position — the same reason
`repository-file.repository.ts`'s column-list `INSERT` never needs casts but its
column-list-free `UPDATE ... FROM (VALUES ...)` does.

### The distance-to-score conversion, and why not `1 - distance`

`embedding <=> $1` is cosine **distance**, range `[0, 2]`, not a similarity and not
bounded to `[0, 1]`. The naive `1 - distance` conversion a reviewer would expect
produces negative scores for any distance above 1 — a legal, unremarkable `<=>` output
for a dissimilar pair — which would silently corrupt the hybrid formula's weighted sum
(every term is assumed to be in `[0, 1]`). The correct affine map is `1 - distance / 2`,
clamped `[0, 1]` defensively for floating-point overshoot at the boundary. This
conversion has exactly one definition in the codebase
(`hybrid-scorer.ts`'s `normalizeVectorScore`) — `search`'s own vector-only path
originally carried a duplicate copy (necessary since sub-task 2.3 landed before
sub-task 2.4's pure module existed) and was refactored to import the pure-module
version in the same commit that added `hybrid-scorer.ts`.

### Set-relative normalization — lexical and fan-in

Both `lexicalScore` (`ts_rank`) and the fan-in half of `recencyOrImportance`
(`RepositoryFile.inboundEdgeCount`) are normalized **within the current candidate set**
— divided by the maximum value present among the candidates being scored, not by any
absolute or historical maximum. `ts_rank` is unbounded above and typically tiny
(0.0–0.1) for real matches; contributed directly at weight 0.15 it would be
decorative. This is a real design decision, not an obvious one: it means both terms
measure "how good is this match relative to the best match this query found," not an
absolute, cross-query-comparable quantity — logged score breakdowns are only
comparable to each other within the same query's result set, not across different
queries. A zero max (no lexical matches at all, or every candidate has zero fan-in)
returns `0` for every candidate rather than dividing by zero.

### Churn deferred from `recencyOrImportance`

Spec §10 names "churn rate / export-ness / fan-in." Churn requires commit history,
which nothing in this system stores yet (Phase 14, incremental indexing, is where that
arrives). Implemented: fan-in (`RepositoryFile.inboundEdgeCount`) and export-ness
(`CodeSymbol.isExported`), combined as an even 50/50 blend — spec §10 gives no
sub-weights for the three named inputs, and with churn absent there is no basis yet to
weight the two available signals unevenly. `RecencyImportanceInput` is a small,
explicit type carrying only the two available fields, so adding churn later is a field
addition, not a rewrite of every call site.

### Graph proximity as a caller-supplied input

`hybridSearch` never queries `CodeDependency` itself. `apps/api` cannot import from
`apps/worker` (ESLint Rule C) and `packages/db` must not import from either, so
`graphProximityByFilePath` is a plain, caller-supplied `Record<filePath, proximity>`
rather than something the store computes. This keeps `VectorStore` a pure
storage-and-retrieval abstraction with no knowledge of the dependency graph — the same
property that keeps a future Qdrant implementation from also having to reproduce graph
traversal (`docs/vector-search.md`). No map supplied (or no entry for a candidate's
path) falls back to `GRAPH_PROXIMITY.NONE` (0.1) uniformly — not a bug; with no graph
signal, the other four terms alone decide the ranking.

### `pathAffinity`'s missing reference path, this phase

`HybridSearchOptions` (sub-task 2.1, matching the prompt's own literal interface) has
no "changed/reference file path" field — only `queryText` and `changedSymbolNames`.
`hybridSearch` therefore always calls `pathAffinity` with `queryFilePath: null`, and
every candidate gets the `NO_REFERENCE` tier (0.5, chosen as the numeric midpoint
rather than `0` — see `hybrid-scorer.ts`'s own comment on why `0` would make
cross-query score logs incomparable). This is a real, honest scope boundary, not an
oversight: Phase 08 is spec's own stated "first consumer that actually calls
[the formula] as part of a real review," and is where a reference path would first
exist to pass in.

### Measured `ef_search`, and the under-return risk in two different shapes

`HNSW_EF_SEARCH_FILTERED = 120` (the middle of spec §22's named 80–200 band) is what
shipped. Two adversarial shapes were measured directly, empirically, in this
environment (`pgvector/pgvector:pg16` via Testcontainers, and cross-checked against a
local `pgvector/pgvector:pg16` container for faster iteration):

1. **One repository dominates the whole table** (the shape `search`/`hybridSearch`'s
   own scale tests use): Postgres only prefers the HNSW index scan over a plain
   scan-and-sort once that repository's own row count reaches the tens of
   thousands — measured at this build: 3,000 rows still chose a Bitmap Heap Scan +
   in-memory sort; 20,000 and 30,000 rows still chose a full Seq Scan + sort; the plan
   flips to `Index Scan using "CodeChunk_embedding_hnsw_idx"` somewhere between 30,000
   and 40,000 rows (50,000 was used for the committed tests as a comfortable margin
   above the measured crossover). Below that crossover, "a few thousand rows" (the
   naive assumption `graph-query-plans.test.ts`'s own precedent might suggest) is
   **not** enough to exercise the index at all in this environment.
2. **One small tenant shares a table with a much larger second tenant**
   (`vector-tenant-isolation.test.ts`'s own shape, repoA 40 rows / repoB 2,000+ rows):
   here the under-return risk did **not** reproduce, even at repoB scaled up to
   100,000 rows in a follow-up check — Postgres's cost model keeps preferring the
   cheap, _exact_ `repositoryId`-index-scan-and-sort plan for repoA's query
   regardless of how large repoB grows, because that plan's cost depends only on
   repoA's own (fixed, small) matching-row count, not on total table size. `ef_search`
   was not the deciding factor in this shape at any scale tested — the planner's own
   selectivity-based cost estimate already protects it. `ef_search` remains the
   correct mitigation for shape 1, which does reproduce, and the constant is exported
   specifically so a future, larger-scale recall test (Prompt 5) can re-measure this
   as real data volumes grow.

### What could not be verified from this environment

- No change from Prompt 1's own list. All of this prompt's own DoD gates (build,
  typecheck, lint, format, unit tests, integration tests including the two scale/
  EXPLAIN-ANALYZE suites and the tenant-isolation suite) ran successfully against the
  local Docker/Testcontainers `pgvector/pgvector:pg16` environment in this session.
