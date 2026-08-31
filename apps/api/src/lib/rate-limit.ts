import { createLogger } from "@repo/observability";
import { getRedisClient } from "./redis.js";

const logger = createLogger("api.rate-limit");

/**
 * A narrow rate limiter, originally single-purpose for exactly one route:
 * `POST /api/repositories/:id/index`'s 10/hour/repository limit (phase-03 §7/§28), and
 * extended in Phase 06 for a second: the per-installation webhook burst guard
 * (`webhooks.controller.ts`, phase-06 §4/§13). No general rate-limiting *middleware*
 * exists in `apps/api` — building one was explicitly out of scope when this file was
 * created, and a single fixed-window counter, parameterized by caller, is still the
 * whole mechanism both call sites need. **What a general solution would look like
 * later**: a `withRateLimit(key, limit, period)` middleware in `lib/http.ts`'s style,
 * applied per-route via `withRoute`'s options (mirroring `component`), backed by the
 * same Redis client — worth building once a third call site needs one, not before
 * (plan.md §28 also names 60/min/user general and 30/hour/user for manual reviews,
 * neither built yet).
 *
 * **Fixed window, not sliding** — the simplest correct implementation of "N per
 * period": `INCR` a key scoped to `(caller-supplied key, window length, current window
 * index)`, `EXPIRE` it once, on the first increment, so the key self-cleans. A fixed
 * window can allow up to 2× the stated limit across a boundary (10 requests just before
 * the window rolls over, 10 more just after) — an accepted imprecision for an abuse
 * guard, not a billing meter; a sliding-window log would be exact but is more Redis
 * calls and more code for limits this generous, at either call site.
 *
 * **Fails open.** If Redis is unreachable, this logs a warning and allows the request
 * rather than blocking a legitimate re-index (or a legitimate webhook delivery) because
 * a cache is down — the same "availability over strict correctness" choice
 * `@repo/github`'s token cache already makes for the identical reason
 * (`packages/github/src/client/token-cache.ts`). A rate limit is an abuse guard, not a
 * security control; failing closed here would turn a Redis blip into an outage of a
 * feature that has nothing to do with Redis. This applies identically to the webhook
 * call site: a rate limiter that fails closed would let a Redis blip do a compromised
 * secret's job for it, silently dropping legitimate deliveries.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Only meaningful when `allowed` is false — seconds until the current window resets. */
  retryAfterSeconds?: number;
}

/** The original, and still the default: `POST /api/repositories/:id/index`'s call site
 * omits `windowSeconds` entirely, so its behaviour is provably unchanged by this
 * parameterization. */
const DEFAULT_WINDOW_SECONDS = 60 * 60;

/**
 * `windowSeconds` defaults to the original one-hour window so the existing
 * `repo-index:${repositoryId}` call site needs no change at all. A caller that does pass
 * a window — the webhook burst guard passes a much shorter one, since a one-hour window
 * is the wrong shape for bounding a burst — gets a Redis key whose bucket is derived
 * from *that* window, not from a shared constant: `windowSeconds` appears both in the
 * epoch-bucket arithmetic (`Math.floor(Date.now() / 1000 / windowSeconds)`) and verbatim
 * in the key text itself. Embedding it in the key text is redundant with the bucket
 * arithmetic for any single call site (a fixed `key` prefix is always called with the
 * same `windowSeconds` in practice) but costs one token, and it means two call sites
 * that ever did reuse the same `key` prefix with different window lengths could not
 * silently share a counter neither intended to share.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
): Promise<RateLimitResult> {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const windowKey = `ratelimit:${key}:${windowSeconds.toString()}:${bucket.toString()}`;

  try {
    const redis = getRedisClient();
    const count = await redis.incr(windowKey);
    if (count === 1) {
      await redis.expire(windowKey, windowSeconds);
    }

    if (count > limit) {
      const ttl = await redis.ttl(windowKey);
      return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
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
