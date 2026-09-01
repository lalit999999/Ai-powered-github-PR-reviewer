# Vector search (`VectorStore`, pgvector, hybrid retrieval — Phase 05 prompt 2)

The `VectorStore` interface contract, the pgvector-vs-Qdrant trade-off, the hybrid
scoring formula, and the `ef_search` tuning knob — written down once, per
phase-05-vector-search.md §16, for whoever eventually migrates the storage layer or
tunes the formula's weights. Everything below lives in `packages/db/src/vector/`.

## The interface

```ts
interface VectorStore {
  upsert(chunks: readonly ChunkUpsertInput[]): Promise<number>;
  search(options: VectorSearchOptions): Promise<ScoredChunk[]>;
  hybridSearch(options: HybridSearchOptions): Promise<ScoredChunk[]>;
  deleteByFilePaths(
    repositoryId: string,
    filePaths: readonly string[],
  ): Promise<number>;
  deleteByRepository(repositoryId: string): Promise<number>;
}
```

- **`upsert`** — batched, idempotent write. Keyed on
  `(repositoryId, contentHash, startLine, filePath)`; a re-run updates `embedding`,
  `embeddingModel`, `commitSha`, `content`, `tokenCount`, `symbols`, `imports`,
  `symbolId`, `fileId` in place and never touches `id`. `embedding: null` is legal —
  it is the PARTIAL/resume path (§4 Reliability): a chunk can be persisted ahead of
  its embedding, then updated once the embedding arrives. Returns the number of rows
  affected.
- **`search`** — vector-only similarity search. `repositoryId` is mandatory by
  construction (not optional, no default — the type signature itself is the tenant
  isolation control, spec §13). Returns `ScoredChunk[]` with `score === vectorScore`
  and the other four components at `0` — the unweighted path.
- **`hybridSearch`** — the real retrieval path: vector similarity + lexical rank +
  graph proximity + recency/importance + path affinity, combined by the formula below.
- **`deleteByFilePaths`** / **`deleteByRepository`** — scoped deletes for the
  re-index full-replace path. `ON DELETE CASCADE` from `Repository`/`RepositoryFile`
  already removes chunks when their parent row is deleted; these methods exist for the
  case where the parent survives but its chunks need replacing.

`ScoredChunk` deliberately carries every score component separately
(`vectorScore`, `graphProximity`, `lexicalScore`, `recencyOrImportance`,
`pathAffinity`), never just the final `score` — `plan.md` §15.5: "you'll tune the
weights from real reviews, and you can't tune what you didn't log."

### Graph proximity is a caller-supplied input

`hybridSearch` never queries `CodeDependency` itself. `apps/api` cannot import from
`apps/worker` (ESLint Rule C) and `packages/db` must not import from either — the only
module with both graph access and a reason to call `hybridSearch` is the caller, so
`graphProximityByFilePath?: Record<string, number>` is a plain, pre-computed input.
This keeps `VectorStore` a pure storage-and-retrieval abstraction with zero knowledge
of the dependency graph, which is also what keeps a future Qdrant implementation from
also having to reproduce graph traversal. No map (or no entry for a given path) falls
back to `GRAPH_PROXIMITY.NONE` (0.1) — a flat, uninformative signal, not a bug.

## Why pgvector for the MVP

`plan.md` §1.3 change ① / Decision D1: a second stateful system (Qdrant) buys nothing
at MVP scale (~4M vectors at the 10-user growth stage, `plan.md` §42.1) and introduces
a real correctness risk — vectors pointing at a commit Postgres has already rolled
back, because two systems with no shared transaction have no transactional consistency
with each other. Keeping chunks in Postgres means:

- `CodeChunk` is a normal table with real foreign keys to `Repository` and
  `RepositoryFile` — deletes are `ON DELETE CASCADE`, not a distributed cleanup job.
- Tenant isolation is a `WHERE "repositoryId" = $1` clause on the same query that
  reads the vectors, not a second isolation model to keep in sync with Postgres's own
  row-level truth.
- Hybrid retrieval is one SQL statement (a CTE union, below) instead of two round
  trips to two systems that then have to be merged and re-scored in the caller.

### The scale threshold for revisiting this

`plan.md` §42.1 names ~30–50M vectors (the "1,000 users" growth stage) as the point
pgvector's filtered-recall and index-build cost stop being the cheaper option — that
row is explicitly labeled "**Migrate vectors to Qdrant** (this is the trigger)."
`plan.md` §42.2 names the intermediate step below that threshold: partitioning
`CodeChunk` by `repositoryId` hash, at roughly 200 repositories. **Not built in this
phase** — but nothing in the schema or this interface forecloses it: no global unique
constraint or cross-partition foreign key that a hash-partitioned `CodeChunk` could not
carry.

### What a Qdrant implementation of this interface would have to reproduce — and lose

1. **`repositoryId` filtering** — a Qdrant payload index on `repositoryId`, queried
   with a mandatory filter, mirroring `VectorSearchOptions.repositoryId` being
   required rather than optional.
2. **The union-then-rescore retrieval shape** (`hybridSearch`) — Qdrant has no native
   full-text index sitting next to its vector index the way Postgres's GIN index sits
   next to the HNSW index on the same table. A Qdrant-backed `hybridSearch` would need
   a second lexical store and a real two-system union — exactly the round-trip cost
   pgvector avoids today.
3. **Transactional consistency with `RepositoryFile`, for free** — pgvector chunks are
   written in the same Postgres instance as the `RepositoryFile`/`CodeSymbol` rows
   they're derived from. Qdrant would need an explicit reconciler process to detect
   and repair drift between the two stores — a failure mode this pgvector
   implementation does not have.
4. **Cascade deletes** — a single `DELETE ... WHERE` in Postgres today; Qdrant would
   need its own delete-by-filter call kept in sync with Postgres's own deletes by
   application code, not a database foreign-key cascade.

## The hybrid scoring formula

```
score = 0.45 · vectorScore
      + 0.20 · graphProximity
      + 0.15 · lexicalScore
      + 0.10 · recencyOrImportance
      + 0.10 · pathAffinity
```

Weights are pinned in `@repo/shared`'s `HYBRID_WEIGHTS` — heuristic, not derived
(`plan.md` §15.5), and expected to be re-tuned once real review data exists. The
formula itself lives in `packages/db/src/vector/hybrid-scorer.ts`, a pure module with
no Prisma, no I/O — every component is independently unit-tested.

| Component             | Source                                                               | Normalization                                                                                                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vectorScore`         | pgvector cosine **distance** (`embedding <=> query`), range `[0, 2]` | `1 - distance / 2`, clamped `[0, 1]`. **Not** `1 - distance` — that goes negative above distance 1 and corrupts the weighted sum.                                                                                                                                                         |
| `lexicalScore`        | Postgres `ts_rank` on `CodeChunk.tsv`                                | Divided by the **maximum `ts_rank` in the current candidate set** — `ts_rank` is unbounded and typically tiny (0.0–0.1), so an absolute value would be decorative at weight 0.15. This makes lexical score relative to the query, not absolute across queries.                            |
| `graphProximity`      | Caller-supplied `filePath -> proximity` map                          | `GRAPH_PROXIMITY` tiers: `1.0` same file, `0.7` direct edge, `0.4` depth-2, `0.1` none/no map supplied. No further normalization.                                                                                                                                                         |
| `recencyOrImportance` | `RepositoryFile.inboundEdgeCount` (fan-in) + `CodeSymbol.isExported` | Fan-in normalized within the candidate set (same technique as lexical); combined with export-ness as an even 50/50 blend — **churn is deferred** (see below), so there is no basis yet to weight the two available signals unevenly.                                                      |
| `pathAffinity`        | Chunk vs. reference file path/package                                | `1.0` same directory, `0.5` same package, `0` otherwise, `0.5` (`NO_REFERENCE`) when no reference path was supplied at all — a genuine midpoint, not `0`, so an absent reference doesn't uniformly depress every candidate's absolute score and make cross-query score logs incomparable. |

**Churn deferral**: spec §10 names "churn rate / export-ness / fan-in" for
`recencyOrImportance`. Churn requires commit history, which nothing in this system
stores yet — Phase 14 (incremental indexing) is where that arrives. Implemented today:
fan-in + export-ness only, behind a small `RecencyImportanceInput` type, so adding
churn later is a field addition, not a rewrite of every call site.

**Tiebreak**: `rescoreAndRank` sorts by descending score, then ascending chunk `id` —
a documented, deterministic tiebreak. Two candidates can legitimately compute the exact
same score, and a database result set's row order is not a meaningful fallback.

## The `hybridSearch` query shape

One SQL statement, three CTEs:

```sql
WITH vector_candidates AS (   -- top 40 by cosine distance, repositoryId-scoped
  ...
),
lexical_candidates AS (       -- top 20 by ts_rank, repositoryId-scoped, websearch_to_tsquery
  ...
),
candidates AS (                -- FULL OUTER JOIN, deduplicated by chunk id
  SELECT COALESCE(v.id, l.id) AS id, v.distance, l."tsRank"
  FROM vector_candidates v FULL OUTER JOIN lexical_candidates l ON v.id = l.id
)
SELECT ... FROM candidates JOIN "CodeChunk" ... LEFT JOIN "RepositoryFile" ... LEFT JOIN "CodeSymbol" ...
```

Both CTEs carry the `repositoryId` filter independently — never just one. The
`FULL OUTER JOIN` + `COALESCE` is what guarantees a chunk present in both candidate
sets produces exactly one merged row, never a duplicate. `websearch_to_tsquery`, not
`to_tsquery`, because it never throws on arbitrary user text (the debug-search panel
passes raw human queries straight through); an empty or stopword-only query text makes
it return an empty tsquery that matches nothing, and the lexical CTE simply contributes
zero rows — no special-casing needed. The SQL computes only raw signals (`distance`,
`ts_rank`, `inboundEdgeCount`, `isExported`); the weighted sum is computed in
TypeScript by `rescoreAndRank`, never in SQL, so the formula stays testable and
tunable without a migration.

## `ef_search` and the under-return failure mode

Postgres applies the HNSW index scan _before_ the `WHERE "repositoryId" = ...` filter.
With many tenants sharing one table, a top-N approximate index scan can — in
principle — return candidates that all belong to other repositories, leaving zero
results for a repository that has plenty of its own chunks. The MVP mitigation is
`SET LOCAL hnsw.ef_search = 120` (the `HNSW_EF_SEARCH_FILTERED` constant), raising the
HNSW search-time candidate list into the 80–200 band recommended for filtered queries,
inside the same transaction as the search itself (`SET LOCAL` does not accept a bind
parameter — verified empirically; the fixed, code-controlled constant is spliced in via
`Prisma.raw`, never anything request-derived).

**Measured in this environment**: the risk as originally framed — one repository's own
row count large enough that the _whole table_ is that repository — only makes Postgres
prefer the HNSW path over a plain scan-and-sort once a single repository's own row
count reaches the tens of thousands (empirically, between 30,000 and 40,000 rows in
this Postgres/pgvector build; see `apps/worker/tests/integration/
vector-search-query-plans.test.ts`'s header comment for the measurements). Below that,
Postgres correctly and cheaply just fetches the matching rows via the
`repositoryId`-prefixed unique index and sorts them directly — a plan that is both
cheaper and _exact_, not approximate.

A second, adversarial shape — one small tenant's chunks sharing a table with a much
larger second tenant's — was also measured directly
(`apps/worker/tests/integration/vector-tenant-isolation.test.ts`): here the small
tenant's own row count stays fixed regardless of how large the other tenant's data
grows, so Postgres's cost model keeps preferring the cheap, exact index-scan-and-sort
plan for the small tenant's query even as the other tenant scales into the hundreds of
thousands of rows. In this shape, the under-return risk did not reproduce even without
`ef_search`'s help — the planner's own selectivity-based cost estimate already protects
it. `ef_search` remains the right, cheap mitigation for the case that does reproduce
(one large, dominant repository being searched directly), and the constant is exported
specifically so a future recall test can re-measure and adjust it.

## Not built yet

- **Qdrant** — the interface exists so this door stays open; nothing is built against
  it in the MVP.
- **`CodeChunk` partitioning by `repositoryId` hash** — the planned intermediate step
  before Qdrant (`plan.md` §42.2), at roughly 200 repositories. Deliberately not built
  here, and deliberately not foreclosed by anything in the schema.
- **Model-based (cross-encoder) re-ranking** — explicitly V2 (spec §3 Out of Scope).
- **A real reference file path for `pathAffinity`** — `HybridSearchOptions` carries no
  "changed file" field in this phase (only `queryText` and `changedSymbolNames`), so
  `pathAffinity` is `NO_REFERENCE` (0.5) for every candidate until Phase 08, the first
  caller with a real changed-file context, extends the options.
