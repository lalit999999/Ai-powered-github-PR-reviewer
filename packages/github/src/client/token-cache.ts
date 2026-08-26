import { createLogger } from "@repo/observability";

/**
 * A tiny key/value cache with a TTL. Values are opaque strings — **this interface knows
 * nothing about GitHub**, tokens, or expiry semantics; app-auth.ts owns all of that.
 *
 * Why an interface instead of calling Redis directly: this project already puts an
 * abstraction in front of an infrastructure choice made for MVP pragmatism (the
 * VectorStore interface over pgvector is the canonical example). Here it has an
 * immediate, concrete payoff — the installation-token expiry-boundary tests
 * (phase-02 §22, a named failure point in plan.md §45) must run in the fast, no-I/O
 * unit suite, which means they need a cache implementation that takes an injectable
 * clock and never opens a socket.
 *
 * Implementations must never log a cached value. Log the key, the hit/miss, and the
 * remaining TTL — never the thing being cached (phase-02 §13).
 */
export interface TokenCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Injectable clock, in epoch milliseconds. Defaults to `Date.now` everywhere. */
export type Clock = () => number;

interface InMemoryEntry {
  value: string;
  expiresAtMs: number;
}

/**
 * Process-local cache. Two jobs:
 *  1. the unit suite's cache, driven by a fake clock so expiry boundaries can be tested
 *     without `setTimeout`;
 *  2. the production fallback when Redis is unreachable (see RedisTokenCache).
 *
 * Expiry is evaluated lazily on read rather than by a timer: a timer per entry would
 * keep the event loop alive and would need clearing on shutdown, for no benefit at this
 * cardinality (one entry per GitHub App installation).
 */
export class InMemoryTokenCache implements TokenCache {
  private readonly entries = new Map<string, InMemoryEntry>();

  constructor(private readonly now: Clock = Date.now) {}

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    // `>=` not `>`: an entry whose TTL has exactly elapsed is expired. The boundary
    // matters — off-by-one on token expiry is a named failure point (plan.md §45).
    if (this.now() >= entry.expiresAtMs) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) {
      this.entries.delete(key);
      return;
    }
    this.entries.set(key, { value, expiresAtMs: this.now() + ttlSeconds * 1000 });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  /** Test/diagnostic helper — deliberately not on the interface. */
  size(): number {
    return this.entries.size;
  }
}

/**
 * The minimal slice of an ioredis client this cache uses. Declared structurally rather
 * than importing ioredis's own type so the unit suite can substitute a stub without
 * pulling the driver in, and so swapping clients later is a one-file change.
 *
 * Signatures verified against the installed ioredis@6.0.0's own type definitions
 * (built/utils/RedisCommander.d.ts) — `set(key, value, "EX", seconds)` and
 * `del(...keys): number` are real overloads there, not assumed from docs.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, secondsToken: "EX", seconds: number): Promise<"OK" | null>;
  del(key: string): Promise<number>;
}

/** How long to stay quiet after logging one Redis failure, so an outage cannot flood logs. */
export const REDIS_ERROR_LOG_WINDOW_MS = 60_000;

/**
 * Redis-backed cache with an in-memory fallback.
 *
 * **Redis-unavailable behavior (decision, see docs/decisions/phase-02-log.md §8):** a
 * Redis error is logged at `warn` at most once per REDIS_ERROR_LOG_WINDOW_MS and then
 * falls through to the in-memory cache — it never fails the caller. Phase-02 §4
 * explicitly sanctions the fallback ("tokens live only in the Redis cache (or
 * in-memory)"). The asymmetry is what decides it: the worst case of a cache miss is one
 * extra JWT→token exchange against GitHub, while failing hard would turn a cache outage
 * into a total outage of every GitHub-touching path in the product.
 *
 * The rate limit on the warning is not cosmetic. Redis is consulted on every GitHub
 * call; without it, a Redis outage would emit a log line per request, which is how a
 * cache incident becomes a logging incident.
 */
export class RedisTokenCache implements TokenCache {
  private readonly logger = createLogger("github.token-cache");
  private readonly fallback: InMemoryTokenCache;
  private lastErrorLoggedAtMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly redis: RedisLike,
    private readonly now: Clock = Date.now,
    fallback: InMemoryTokenCache = new InMemoryTokenCache(now),
  ) {
    this.fallback = fallback;
  }

  async get(key: string): Promise<string | null> {
    try {
      const value = await this.redis.get(key);
      // A Redis miss still consults the fallback: an earlier write may have landed there
      // instead of Redis, during an outage that has since recovered.
      return value ?? (await this.fallback.get(key));
    } catch (error) {
      this.logRedisFailure("get", key, error);
      return this.fallback.get(key);
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) {
      await this.delete(key);
      return;
    }
    try {
      await this.redis.set(key, value, "EX", ttlSeconds);
    } catch (error) {
      this.logRedisFailure("set", key, error);
      await this.fallback.set(key, value, ttlSeconds);
    }
  }

  async delete(key: string): Promise<void> {
    // Always clear the fallback too — a stale in-memory copy written during an outage
    // must not outlive an explicit invalidation of the Redis copy.
    await this.fallback.delete(key);
    try {
      await this.redis.del(key);
    } catch (error) {
      this.logRedisFailure("delete", key, error);
    }
  }

  private logRedisFailure(operation: string, key: string, error: unknown): void {
    const nowMs = this.now();
    if (nowMs - this.lastErrorLoggedAtMs < REDIS_ERROR_LOG_WINDOW_MS) return;
    this.lastErrorLoggedAtMs = nowMs;
    this.logger.warn("redis cache unavailable — falling back to in-memory cache", {
      operation,
      // The key, never the value. A token-cache key is derived from an installation id
      // and is not a secret; the value it guards is.
      cacheKey: key,
      error: error instanceof Error ? error.message : String(error),
      suppressionWindowMs: REDIS_ERROR_LOG_WINDOW_MS,
    });
  }
}
