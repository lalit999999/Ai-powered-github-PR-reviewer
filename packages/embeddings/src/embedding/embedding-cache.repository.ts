import { Prisma, prisma } from "@repo/db";
import { createLogger, type Logger } from "@repo/observability";

/**
 * Phase 05 prompt 3, sub-task 3.7. The `.repository.ts` suffix is mandatory — ESLint
 * Rule B allows only `packages/db/**` or a `*.repository.ts` file to touch Prisma-backed
 * exports (`eslint.config.mjs`'s Rule B `ignores`). Phase 04 hit this exact constraint
 * and renamed `graph-queries.ts` to `graph-queries.repository.ts`
 * (apps/worker/src/indexing/graph/graph-queries.repository.ts) to satisfy it; this file
 * follows that precedent, just inside `packages/embeddings` rather than `apps/worker`
 * (the rule matches on filename, not location).
 *
 * ## Two layers, two failure modes (§2.5)
 *
 * Postgres (`EmbeddingCache`) is the source of truth — durable, and the thing spec §14's
 * "hit count increases across repositories sharing common boilerplate" is actually
 * observed against. Redis is an optional accelerator: `getCached`/`putCached` both take
 * an optional {@link RedisLike} dependency and work correctly (just slower) with none
 * supplied at all. Every Redis call is wrapped so a connection error logs at `warn` and
 * falls through to Postgres — matching `packages/github/src/client/token-cache.ts`'s own
 * fail-open precedent (`RedisTokenCache`) — an index run must never fail because Redis
 * blinked.
 *
 * ## `model` is part of cache identity, not decoration
 *
 * `EmbeddingCache` has `contentHash` alone as its primary key (schema.prisma) — a model
 * change would silently *overwrite* an existing row rather than coexist alongside it.
 * Spec §22 names exactly this ("forgetting to store `embeddingModel`") as a top failure
 * point. The decision made here: **reads always filter by `model`**, so a hash cached
 * under a different model always misses and is never served as a false hit; **writes
 * overwrite** on conflict (`ON CONFLICT ("contentHash") DO UPDATE ... "model" =
 * EXCLUDED."model"`), so a model migration gradually converts the table to the new
 * model, one re-embedded chunk at a time, rather than requiring an explicit truncation
 * step. The Redis key includes `model` for the identical reason, at the identical layer.
 */

// ---------------------------------------------------------------------------
// Redis — the accelerator layer
// ---------------------------------------------------------------------------

/** The minimal slice of an ioredis client this cache uses — declared structurally, same
 * discipline as `token-cache.ts`'s own `RedisLike`, so the unit/integration suite can
 * substitute a stub without pulling the driver in. */
export interface RedisLike {
  mget(keys: string[]): Promise<(string | null)[]>;
  set(
    key: string,
    value: string,
    secondsToken: "EX",
    seconds: number,
  ): Promise<"OK" | null>;
}

/**
 * A 1024-dimension float vector is ~8KB as JSON (spec §2.5's own estimate) — real memory
 * at a meaningful hit rate over a large repository. 7 days balances that against the use
 * case spec §14 names explicitly: cache hits *across repositories* sharing common
 * boilerplate, which can be indexed days apart, not just within one run. Postgres stays
 * authoritative regardless of this TTL — a Redis expiry is just a fallback to the slower
 * layer, never data loss.
 *
 * There is no separate max-entry-count setting here — bounding total Redis memory is a
 * deployment-level concern (`maxmemory` + an eviction policy such as `allkeys-lru` on the
 * Redis instance itself), the same layer that already bounds every other cache sharing
 * this Redis (`packages/github/src/client/token-cache.ts`), not something this client
 * enforces per key.
 */
export const EMBEDDING_CACHE_REDIS_TTL_SECONDS = 60 * 60 * 24 * 7;

function redisKey(model: string, contentHash: string): string {
  return `embcache:${model}:${contentHash}`;
}

// ---------------------------------------------------------------------------
// halfvec <-> number[] — the same wire format pgvector.store.ts's embeddingFragment
// writes (`'[0.1,0.2,...]'::halfvec(1024)`), read back via an explicit ::text cast since
// Prisma's typed client has no representation for an Unsupported() column.
// ---------------------------------------------------------------------------

function embeddingLiteral(embedding: readonly number[]): Prisma.Sql {
  const literal = `[${embedding.join(",")}]`;
  return Prisma.sql`${literal}::halfvec(1024)`;
}

function parseHalfvecText(text: string): number[] {
  return text
    .slice(1, -1)
    .split(",")
    .map((n) => Number(n));
}

// ---------------------------------------------------------------------------
// getCached — Redis first, then Postgres for the misses, then backfill Redis
// ---------------------------------------------------------------------------

export interface EmbeddingCacheDeps {
  redis?: RedisLike;
  logger?: Logger;
}

interface EmbeddingCacheRow {
  contentHash: string;
  embeddingText: string;
}

/**
 * One batched Postgres query for every miss after the Redis pass
 * (`WHERE "contentHash" = ANY(...) AND "model" = ...`), never a loop of single lookups —
 * matching every other `*.repository.ts` in this codebase's own batching discipline.
 * Newly-found Postgres hits are backfilled into Redis (fire-and-forget-safe: another
 * Redis failure here just logs and is otherwise ignored, since the value is already
 * correctly returned to the caller regardless).
 *
 * Does **not** call {@link recordHits} itself — see that function's own doc comment for
 * the write-cost trade-off this split is for.
 */
export async function getCached(
  contentHashes: readonly string[],
  model: string,
  deps: EmbeddingCacheDeps = {},
): Promise<Map<string, number[]>> {
  const logger = deps.logger ?? createLogger("indexing.embedding-cache");
  const result = new Map<string, number[]>();
  if (contentHashes.length === 0) return result;

  let misses = [...contentHashes];

  if (deps.redis) {
    try {
      const keys = misses.map((hash) => redisKey(model, hash));
      const values = await deps.redis.mget(keys);
      const stillMissing: string[] = [];
      values.forEach((raw, i) => {
        const hash = misses[i]!;
        if (raw === null) {
          stillMissing.push(hash);
          return;
        }
        try {
          result.set(hash, JSON.parse(raw) as number[]);
        } catch {
          // A corrupted Redis value is treated as a miss, not a fatal error — Postgres
          // remains authoritative and will simply re-serve (and re-backfill) it.
          stillMissing.push(hash);
        }
      });
      misses = stillMissing;
    } catch (error) {
      logger.warn(
        "redis unavailable for embedding cache lookup — falling back to postgres",
        { error: error instanceof Error ? error.message : String(error) },
      );
      // misses stays as the full original list — every hash falls through to Postgres.
    }
  }

  if (misses.length === 0) return result;

  const rows = await prisma.$queryRaw<EmbeddingCacheRow[]>`
    SELECT "contentHash", "embedding"::text AS "embeddingText"
    FROM "EmbeddingCache"
    WHERE "contentHash" = ANY(${misses}) AND "model" = ${model} AND "embedding" IS NOT NULL
  `;

  if (rows.length > 0 && deps.redis) {
    try {
      await Promise.all(
        rows.map((row) =>
          deps.redis!.set(
            redisKey(model, row.contentHash),
            JSON.stringify(parseHalfvecText(row.embeddingText)),
            "EX",
            EMBEDDING_CACHE_REDIS_TTL_SECONDS,
          ),
        ),
      );
    } catch (error) {
      logger.warn("redis unavailable while backfilling embedding cache hits", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const row of rows) {
    result.set(row.contentHash, parseHalfvecText(row.embeddingText));
  }

  return result;
}

// ---------------------------------------------------------------------------
// putCached — write Postgres, then Redis
// ---------------------------------------------------------------------------

export interface EmbeddingCacheEntry {
  contentHash: string;
  embedding: readonly number[];
}

/** Same reasoning as `pgvector.store.ts`'s `CODE_CHUNK_BATCH_SIZE`: a full-dimension
 * embedding is a large value per row, so a smaller batch than the 1,000-row convention
 * used for narrow rows keeps one statement in a comparable byte-size range. */
export const EMBEDDING_CACHE_BATCH_SIZE = 500;

async function putBatch(
  batch: readonly EmbeddingCacheEntry[],
  model: string,
): Promise<void> {
  if (batch.length === 0) return;
  const now = new Date();
  const rows = Prisma.join(
    batch.map(
      (e) =>
        Prisma.sql`(${e.contentHash}, ${model}, 0, ${now}, ${embeddingLiteral(e.embedding)})`,
    ),
  );

  await prisma.$executeRaw`
    INSERT INTO "EmbeddingCache" ("contentHash", "model", "hits", "lastUsedAt", "embedding")
    VALUES ${rows}
    ON CONFLICT ("contentHash") DO UPDATE SET
      "model" = EXCLUDED."model",
      "embedding" = EXCLUDED."embedding",
      "hits" = "EmbeddingCache"."hits" + 1,
      "lastUsedAt" = EXCLUDED."lastUsedAt"
  `;
}

/** Writes Postgres first (the source of truth), then Redis — the reverse of
 * {@link getCached}'s read order, so a reader can never observe a Redis-only value that
 * Postgres does not yet have. A `hits` of `0` on a fresh insert: this call represents a
 * chunk just *computed*, not yet served as a cache hit; the `ON CONFLICT` branch (a race,
 * or a model migration re-embedding an already-cached hash) increments the existing
 * counter instead. */
export async function putCached(
  entries: readonly EmbeddingCacheEntry[],
  model: string,
  deps: EmbeddingCacheDeps = {},
): Promise<void> {
  if (entries.length === 0) return;
  const logger = deps.logger ?? createLogger("indexing.embedding-cache");

  for (
    let offset = 0;
    offset < entries.length;
    offset += EMBEDDING_CACHE_BATCH_SIZE
  ) {
    await putBatch(
      entries.slice(offset, offset + EMBEDDING_CACHE_BATCH_SIZE),
      model,
    );
  }

  if (deps.redis) {
    try {
      await Promise.all(
        entries.map((e) =>
          deps.redis!.set(
            redisKey(model, e.contentHash),
            JSON.stringify(e.embedding),
            "EX",
            EMBEDDING_CACHE_REDIS_TTL_SECONDS,
          ),
        ),
      );
    } catch (error) {
      logger.warn("redis unavailable while writing embedding cache entries", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// recordHits — a deliberately separate write from the read path
// ---------------------------------------------------------------------------

/**
 * Increments `hits` and bumps `lastUsedAt` for every hash in `contentHashes`, one batched
 * `UPDATE ... WHERE "contentHash" = ANY(...)` statement. No `model` filter is needed —
 * `EmbeddingCache`'s primary key is `contentHash` alone, so at most one row exists per
 * hash at any time regardless of which model most recently wrote it.
 *
 * **Deliberately not folded into `getCached`.** A write costs more than the read that
 * found the value, and `getCached` may be called speculatively (a pre-flight "what's
 * already cached" check) as well as for real hits about to be used — always paying an
 * `UPDATE` on every read would double the write load for no benefit in the speculative
 * case. The caller (Prompt 4's pipeline) calls this once, batched, with the full set of
 * hashes that were genuinely used as cache hits for a run.
 */
export async function recordHits(
  contentHashes: readonly string[],
): Promise<void> {
  if (contentHashes.length === 0) return;
  await prisma.$executeRaw`
    UPDATE "EmbeddingCache"
    SET "hits" = "hits" + 1, "lastUsedAt" = now()
    WHERE "contentHash" = ANY(${contentHashes})
  `;
}
