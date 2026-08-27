import { Redis } from "ioredis";
import { createLogger } from "@repo/observability";
import { getGithubClientConfig } from "../config.js";
import {
  InMemoryTokenCache,
  RedisTokenCache,
  type TokenCache,
} from "./token-cache.js";

const logger = createLogger("github.redis");

/** Give up on a connection attempt rather than hanging a user-facing request behind it. */
export const REDIS_CONNECT_TIMEOUT_MS = 5_000;

let client: Redis | undefined;
let cache: TokenCache | undefined;

/**
 * The one place a Redis connection is created. Verified against the installed
 * ioredis@6.0.0's own RedisOptions type definition, not the published docs:
 *
 * - `lazyConnect` — do not dial Redis at import time. Importing this module must stay
 *   free, or every unit test and every `--help`-style boot pays for a socket.
 * - `connectTimeout` — a hung connect must not hang a request.
 * - `maxRetriesPerRequest: 1` — ioredis's default is to keep retrying a command across
 *   reconnects. For a *cache* that is exactly wrong: the caller would rather take a miss
 *   and mint a fresh token than wait. One retry, then the command rejects and
 *   RedisTokenCache falls through to memory.
 * - `enableOfflineQueue: false` — for the same reason. Queuing commands while
 *   disconnected converts an outage into unbounded latency instead of a fast miss.
 *
 * The 'error' listener is not optional: an ioredis client with no error listener emits
 * an unhandled 'error' event, which crashes the process. Errors are logged and otherwise
 * swallowed here precisely because RedisTokenCache already degrades gracefully.
 */
export function getRedisClient(): Redis {
  if (client) return client;

  client = new Redis(getGithubClientConfig().redisUrl, {
    lazyConnect: true,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
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

/**
 * The process-wide installation-token cache. Redis-backed, with the in-memory fallback
 * described in token-cache.ts. Lazily constructed so importing this module never opens
 * a connection.
 */
export function getTokenCache(): TokenCache {
  cache ??= new RedisTokenCache(getRedisClient());
  return cache;
}

/**
 * Test/CI seam: substitute a cache (typically an InMemoryTokenCache with a fake clock)
 * without a running Redis. Deliberately explicit rather than an env-var branch — a
 * config flag that silently disables the real cache in production is a worse failure
 * than a test that has to wire its own.
 */
export function setTokenCacheForTesting(
  replacement: TokenCache = new InMemoryTokenCache(),
): void {
  cache = replacement;
}

/** Closes the shared client if one was ever opened. For graceful shutdown and tests. */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  const current = client;
  client = undefined;
  cache = undefined;
  current.disconnect();
}
