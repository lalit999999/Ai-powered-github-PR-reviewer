import { createLogger } from "@repo/observability";
import { getRedisClient } from "./redis.js";

const logger = createLogger("api.rate-limit");

/**
 * A narrow, single-purpose rate limiter for exactly one route:
 * `POST /api/repositories/:id/index`'s 10/hour/repository limit (phase-03 §7/§28). No
 * general rate-limiting middleware exists in `apps/api` — building one was explicitly
 * out of this prompt's scope, and a single fixed-window counter is the whole mechanism
 * this one route needs. **What a general solution would look like later**: a
 * `withRateLimit(key, limit, period)` middleware in `lib/http.ts`'s style, applied
 * per-route via `withRoute`'s options (mirroring `component`), backed by the same Redis
 * client — worth building once a second route needs one, not before (plan.md §28 also
 * names 60/min/user general and 30/hour/user for manual reviews, neither built yet).
 *
 * **Fixed window, not sliding** — the simplest correct implementation of "N per period":
 * `INCR` a key scoped to `(repositoryId, current hour)`, `EXPIRE` it once, on the first
 * increment, so the key self-cleans. A fixed window can allow up to 2× the stated limit
 * across a boundary (10 requests just before the hour rolls over, 10 more just after) —
 * an accepted imprecision for an abuse guard, not a billing meter; a sliding-window log
 * would be exact but is more Redis calls and more code for a limit this generous.
 *
 * **Fails open.** If Redis is unreachable, this logs a warning and allows the request
 * rather than blocking a legitimate re-index because a cache is down — the same
 * "availability over strict correctness" choice `@repo/github`'s token cache already
 * makes for the identical reason (`packages/github/src/client/token-cache.ts`). A rate
 * limit is an abuse guard, not a security control; failing closed here would turn a
 * Redis blip into an outage of a feature that has nothing to do with Redis.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Only meaningful when `allowed` is false — seconds until the current window resets. */
  retryAfterSeconds?: number;
}

const WINDOW_SECONDS = 60 * 60;

export async function checkRateLimit(key: string, limit: number): Promise<RateLimitResult> {
  const windowKey = `ratelimit:${key}:${Math.floor(Date.now() / 1000 / WINDOW_SECONDS).toString()}`;

  try {
    const redis = getRedisClient();
    const count = await redis.incr(windowKey);
    if (count === 1) {
      await redis.expire(windowKey, WINDOW_SECONDS);
    }

    if (count > limit) {
      const ttl = await redis.ttl(windowKey);
      return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : WINDOW_SECONDS };
    }

    return { allowed: true };
  } catch (error) {
    logger.warn("rate limit check failed — failing open", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: true };
  }
}
