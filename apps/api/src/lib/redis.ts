import { Redis } from "ioredis";
import { createLogger } from "@repo/observability";
import { env } from "../config/env.js";

const logger = createLogger("api.redis");

/**
 * `apps/api`'s own Redis connection, for the rate limiter (`lib/rate-limit.ts`) — a
 * **separate** client instance from `@repo/github`'s own (`packages/github/src/client/redis.ts`),
 * even though both ultimately point at the same `REDIS_URL`. Reusing `@repo/github`'s
 * client would mean importing `@repo/github` from `apps/api` for a purpose that has
 * nothing to do with GitHub — and `getRedisClient` is not part of that package's public
 * surface in the first place (deliberately: token-cache internals stay internal). A
 * second small client, built the same verified way, is simpler than either exporting an
 * internal it was never meant to expose or threading a shared `@repo/redis` package
 * through the workspace for exactly one additional consumer — see
 * docs/decisions/phase-03-log.md for the fuller argument, including what the
 * general-purpose version of this would look like once a third consumer needs it.
 *
 * Same options as `@repo/github`'s client, verified against the same installed
 * `ioredis@6.0.0` `RedisOptions` type: `lazyConnect` (importing this module never dials
 * a socket), `connectTimeout` (a hung connect must not hang a request),
 * `maxRetriesPerRequest: 1` + `enableOfflineQueue: false` (a rate limiter would rather
 * fail open on a miss than block a request on a disconnected Redis — see
 * `rate-limit.ts`).
 */
const CONNECT_TIMEOUT_MS = 5_000;

let client: Redis | undefined;

export function getRedisClient(): Redis {
  if (client) return client;

  client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  client.on("error", (error: Error) => {
    logger.warn("redis connection error", { error: error.message });
  });
  client.on("connect", () => {
    logger.info("redis connected");
  });

  return client;
}

/** Test/CI seam and graceful shutdown — mirrors `@repo/github`'s `closeRedis`. */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  const current = client;
  client = undefined;
  current.disconnect();
}
