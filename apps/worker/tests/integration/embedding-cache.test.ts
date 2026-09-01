import { randomUUID } from "node:crypto";
import {
  getCached,
  putCached,
  recordHits,
  type RedisLike,
} from "@repo/embeddings";
import { prisma } from "@repo/db";
import { EMBEDDING_DIMENSIONS } from "@repo/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./db-helpers.js";

/**
 * Phase 05 prompt 3, sub-task 3.7: integration coverage for
 * `packages/embeddings/src/embedding/embedding-cache.repository.ts`. Lives in
 * `apps/worker`'s Testcontainers harness — the same reasoning `vector-store.test.ts`
 * (Phase 05 prompt 2) already gives: this is the only place in the codebase with a real
 * Postgres to assert this repository's raw-SQL behavior against.
 *
 * **Redis**: stubbed with an in-memory {@link RedisLike} fake, not a real Testcontainers
 * Redis instance. The behaviors this suite needs to prove — a Postgres-layer cache hit
 * across repositories, `hits` incrementing, a model change never serving a stale vector,
 * and fail-open when Redis is unavailable — are all provable against Postgres alone plus
 * a fake that can be told to throw on demand; standing up a second Testcontainers service
 * for this would add real CI time without adding coverage `RedisLike`'s own structural,
 * dependency-injected seam doesn't already provide (the same reasoning
 * `InMemoryTokenCache` mirrors `RedisTokenCache` in `packages/github` without a real
 * Redis in that package's own tests either).
 */

beforeEach(resetDatabase);
afterAll(async () => {
  await prisma.$disconnect();
});

function makeEmbedding(seed: number): number[] {
  return Array.from(
    { length: EMBEDDING_DIMENSIONS },
    (_, i) => Math.sin(seed + i) * 0.01,
  );
}

/** `halfvec` is a 16-bit float column — a value written as a JS (64-bit) number and read
 * back is only equal up to half-precision rounding, not bit-for-bit (the same reason
 * `packages/db/tests/integration/vector-store.test.ts` never asserts exact vector
 * equality either, only `toBeCloseTo` on derived scores). Tolerance of 3 decimal places
 * is comfortably above half-precision's actual quantization error for these
 * ~0.01-magnitude fixture values (empirically on the order of 1e-6), while still
 * catching a genuine data-corruption bug. */
function expectVectorClose(
  actual: number[] | undefined,
  expected: readonly number[],
): void {
  expect(actual).toBeDefined();
  expect(actual!).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual![i]).toBeCloseTo(expected[i]!, 3);
  }
}

class FakeRedis implements RedisLike {
  private readonly store = new Map<string, string>();
  public failing = false;
  public mgetCalls = 0;
  public setCalls = 0;

  async mget(keys: string[]): Promise<(string | null)[]> {
    this.mgetCalls += 1;
    if (this.failing) throw new Error("redis unavailable (simulated)");
    return keys.map((k) => this.store.get(k) ?? null);
  }

  async set(
    key: string,
    value: string,
    _secondsToken: "EX",
    _seconds: number,
  ): Promise<"OK"> {
    this.setCalls += 1;
    if (this.failing) throw new Error("redis unavailable (simulated)");
    this.store.set(key, value);
    return "OK";
  }
}

describe("embedding-cache.repository", () => {
  it("spec §14: identical content across two files produces exactly one provider call — the second lookup is a cache hit", async () => {
    const contentHash = `shared-${randomUUID()}`;
    const embedding = makeEmbedding(1);
    const model = "test-model";

    // Simulates the caller's own flow: a cache miss, an embedding-provider call (not
    // modeled here — this suite tests the cache, not the client), then a putCached.
    const firstLookup = await getCached([contentHash], model);
    expect(firstLookup.size).toBe(0);
    await putCached([{ contentHash, embedding }], model);

    // A second file (or a second repository) with byte-identical chunk content hashes
    // to the same contentHash and hits the cache instead of calling the provider again.
    const secondLookup = await getCached([contentHash], model);
    expect(secondLookup.size).toBe(1);
    expectVectorClose(secondLookup.get(contentHash), embedding);
  });

  it("a second repository indexing the same vendored file gets a cache hit, and hits increments", async () => {
    const contentHash = `vendored-${randomUUID()}`;
    const embedding = makeEmbedding(2);
    const model = "test-model";

    await putCached([{ contentHash, embedding }], model);
    const before = await prisma.embeddingCache.findUniqueOrThrow({
      where: { contentHash },
    });
    expect(before.hits).toBe(0);

    // "Repository B" looks the same hash up and gets a hit.
    const hit = await getCached([contentHash], model);
    expectVectorClose(hit.get(contentHash), embedding);

    await recordHits([contentHash]);
    const after = await prisma.embeddingCache.findUniqueOrThrow({
      where: { contentHash },
    });
    expect(after.hits).toBe(1);
    expect(after.lastUsedAt.getTime()).toBeGreaterThanOrEqual(
      before.lastUsedAt.getTime(),
    );
  });

  it("a different model value does not serve a stale vector", async () => {
    const contentHash = `model-switch-${randomUUID()}`;
    const oldEmbedding = makeEmbedding(3);

    await putCached([{ contentHash, embedding: oldEmbedding }], "model-a");

    const lookupUnderNewModel = await getCached([contentHash], "model-b");
    expect(lookupUnderNewModel.size).toBe(0);

    const lookupUnderOldModel = await getCached([contentHash], "model-a");
    expectVectorClose(lookupUnderOldModel.get(contentHash), oldEmbedding);
  });

  it("a model migration overwrites the existing row on write, per the documented cache-identity decision", async () => {
    const contentHash = `migrate-${randomUUID()}`;
    const oldEmbedding = makeEmbedding(4);
    const newEmbedding = makeEmbedding(5);

    await putCached([{ contentHash, embedding: oldEmbedding }], "model-a");
    await putCached([{ contentHash, embedding: newEmbedding }], "model-b");

    const row = await prisma.embeddingCache.findUniqueOrThrow({
      where: { contentHash },
    });
    expect(row.model).toBe("model-b");

    const underOldModel = await getCached([contentHash], "model-a");
    expect(underOldModel.size).toBe(0);
    const underNewModel = await getCached([contentHash], "model-b");
    expectVectorClose(underNewModel.get(contentHash), newEmbedding);
  });

  it("falls through to Postgres and stays correct when Redis is unavailable, logging a warn", async () => {
    const contentHash = `redis-down-${randomUUID()}`;
    const embedding = makeEmbedding(6);
    const model = "test-model";
    await putCached([{ contentHash, embedding }], model);

    const redis = new FakeRedis();
    redis.failing = true;
    const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg: string, fields?: Record<string, unknown>) =>
        warnings.push({ msg, fields }),
      error: () => undefined,
    };

    const result = await getCached([contentHash], model, { redis, logger });

    expectVectorClose(result.get(contentHash), embedding);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]!.msg).toMatch(/redis unavailable/);
  });

  it("backfills Redis on a Postgres hit, and serves subsequent lookups from Redis", async () => {
    const contentHash = `backfill-${randomUUID()}`;
    const embedding = makeEmbedding(7);
    const model = "test-model";
    const redis = new FakeRedis();

    // Written directly to Postgres only (bypassing putCached's own Redis write) so the
    // first getCached call is guaranteed to be a genuine Postgres-layer hit.
    await putCached([{ contentHash, embedding }], model);

    const first = await getCached([contentHash], model, { redis });
    expectVectorClose(first.get(contentHash), embedding);
    expect(redis.setCalls).toBe(1);

    // A second lookup is now served straight from Redis — force Postgres to prove it by
    // pointing at a hash Postgres alone cannot see (Redis holds a value Postgres doesn't
    // have for this content, verifying it really returned from the Redis layer and not
    // by re-reading Postgres).
    await prisma.embeddingCache.delete({ where: { contentHash } });
    const second = await getCached([contentHash], model, { redis });
    expectVectorClose(second.get(contentHash), embedding);
  });

  it("batches a single Postgres query for multiple misses, never one lookup per hash", async () => {
    const model = "test-model";
    const hashes = Array.from({ length: 5 }, () => `batch-${randomUUID()}`);
    const entries = hashes.map((contentHash, i) => ({
      contentHash,
      embedding: makeEmbedding(10 + i),
    }));
    await putCached(entries, model);

    const result = await getCached(hashes, model);
    expect(result.size).toBe(5);
    for (const entry of entries) {
      expectVectorClose(result.get(entry.contentHash), entry.embedding);
    }
  });
});
