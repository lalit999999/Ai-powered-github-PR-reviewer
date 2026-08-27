import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@repo/observability";
import {
  InMemoryTokenCache,
  REDIS_ERROR_LOG_WINDOW_MS,
  RedisTokenCache,
  type RedisLike,
} from "./token-cache.js";

/** A controllable clock, in epoch ms, so TTL boundaries are tested without setTimeout. */
function fakeClock(startMs = 1_700_000_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advanceSeconds(seconds: number) {
      nowMs += seconds * 1000;
    },
  };
}

/** A minimal in-memory stand-in for ioredis, with no TTL semantics of its own. */
function stubRedis(): RedisLike & {
  store: Map<string, string>;
  calls: string[];
} {
  const store = new Map<string, string>();
  const calls: string[] = [];
  return {
    store,
    calls,
    async get(key) {
      calls.push(`get:${key}`);
      return store.get(key) ?? null;
    },
    async set(key, value) {
      calls.push(`set:${key}`);
      store.set(key, value);
      return "OK" as const;
    },
    async del(key) {
      calls.push(`del:${key}`);
      return store.delete(key) ? 1 : 0;
    },
  };
}

function failingRedis(message = "ECONNREFUSED"): RedisLike {
  return {
    get: () => Promise.reject(new Error(message)),
    set: () => Promise.reject(new Error(message)),
    del: () => Promise.reject(new Error(message)),
  };
}

describe("InMemoryTokenCache", () => {
  it("returns a stored value (hit)", async () => {
    const cache = new InMemoryTokenCache();
    await cache.set("k", "v", 60);
    expect(await cache.get("k")).toBe("v");
  });

  it("returns null for an unknown key (miss)", async () => {
    expect(await new InMemoryTokenCache().get("nope")).toBeNull();
  });

  it("expires an entry exactly at its TTL, not a tick later", async () => {
    const clock = fakeClock();
    const cache = new InMemoryTokenCache(clock.now);
    await cache.set("k", "v", 60);

    clock.advanceSeconds(59);
    expect(await cache.get("k")).toBe("v");

    clock.advanceSeconds(1); // exactly at the boundary — already expired
    expect(await cache.get("k")).toBeNull();
  });

  it("drops the entry from memory once it expires rather than retaining it", async () => {
    const clock = fakeClock();
    const cache = new InMemoryTokenCache(clock.now);
    await cache.set("k", "v", 10);
    clock.advanceSeconds(11);
    await cache.get("k");
    expect(cache.size()).toBe(0);
  });

  it("treats a zero or negative TTL as a delete, never as 'cache forever'", async () => {
    const cache = new InMemoryTokenCache();
    await cache.set("k", "v", 60);
    await cache.set("k", "v2", 0);
    expect(await cache.get("k")).toBeNull();
    await cache.set("k", "v3", -5);
    expect(await cache.get("k")).toBeNull();
  });

  it("deletes a key", async () => {
    const cache = new InMemoryTokenCache();
    await cache.set("k", "v", 60);
    await cache.delete("k");
    expect(await cache.get("k")).toBeNull();
  });
});

describe("RedisTokenCache", () => {
  it("round-trips through Redis when Redis is healthy", async () => {
    const redis = stubRedis();
    const cache = new RedisTokenCache(redis);

    await cache.set("k", "v", 60);
    expect(await cache.get("k")).toBe("v");
    expect(redis.calls).toEqual(["set:k", "get:k"]);
  });

  it("passes the TTL through as an EX expiry rather than writing an immortal key", async () => {
    const redis = stubRedis();
    const setSpy = vi.spyOn(redis, "set");
    await new RedisTokenCache(redis).set("k", "v", 3000);
    expect(setSpy).toHaveBeenCalledWith("k", "v", "EX", 3000);
  });

  it("falls back to the in-memory cache when Redis errors, instead of failing the caller", async () => {
    const cache = new RedisTokenCache(failingRedis());
    await expect(cache.set("k", "v", 60)).resolves.toBeUndefined();
    expect(await cache.get("k")).toBe("v");
  });

  it("consults the fallback when Redis returns a miss, so a write made during an outage survives recovery", async () => {
    const fallback = new InMemoryTokenCache();
    await fallback.set("k", "written-during-outage", 60);
    const cache = new RedisTokenCache(stubRedis(), Date.now, fallback);
    expect(await cache.get("k")).toBe("written-during-outage");
  });

  it("clears the in-memory copy on delete even when Redis is down", async () => {
    const cache = new RedisTokenCache(failingRedis());
    await cache.set("k", "v", 60);
    await cache.delete("k");
    expect(await cache.get("k")).toBeNull();
  });

  it("logs a Redis failure once per window, not once per call (an outage must not flood logs)", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, callback) {
        lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
        callback();
      },
    });
    const instance = pino(
      { level: "debug", base: null, timestamp: false, messageKey: "msg" },
      stream,
    );
    const clock = fakeClock();
    const cache = new RedisTokenCache(failingRedis(), clock.now);
    // Point the cache's logger at the capturing stream. The logger is private by design
    // (nothing outside the class should log for it), so this test reaches in rather than
    // widening the production surface for a test's convenience.
    Reflect.set(cache, "logger", createLogger("github.token-cache", instance));

    await cache.get("a");
    await cache.get("b");
    await cache.get("c");
    expect(lines).toHaveLength(1);

    clock.advanceSeconds(REDIS_ERROR_LOG_WINDOW_MS / 1000 + 1);
    await cache.get("d");
    expect(lines).toHaveLength(2);
  });

  it("never writes a cached value into its log output", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, callback) {
        lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
        callback();
      },
    });
    const instance = pino(
      { level: "debug", base: null, timestamp: false, messageKey: "msg" },
      stream,
    );
    const cache = new RedisTokenCache(failingRedis(), Date.now);
    Reflect.set(cache, "logger", createLogger("github.token-cache", instance));

    await cache.set("gh:install-token:42", "ghs_supersecrettokenvalue", 60);

    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain("ghs_supersecrettokenvalue");
    // The key, on the other hand, is logged on purpose — it is a diagnostic, not a secret.
    expect(JSON.stringify(lines)).toContain("gh:install-token:42");
  });
});
