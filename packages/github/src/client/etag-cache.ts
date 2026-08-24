import type { Octokit } from "@octokit/core";
import { createLogger, type Logger } from "@repo/observability";
import type { TokenCache } from "./token-cache.js";

/**
 * Conditional-request (ETag) caching for the GitHub client.
 *
 * **Why this is hand-rolled.** The npm registry was checked for an off-the-shelf
 * ETag-caching Octokit plugin: `octokit-plugin-etag-cache`, `@octokit/plugin-etag-cache`,
 * `octokit-plugin-cache` and `@gr2m/octokit-plugin-cache` all 404. There is no credible,
 * maintained package to depend on, so this is ~80 lines built on Octokit's own public
 * `hook.wrap("request", …)` API rather than a dependency that does not exist.
 * (docs/decisions/phase-02-log.md §9.)
 *
 * **Why it matters.** A `304 Not Modified` does not count against the 5,000 req/hr
 * per-installation budget, so repeated reads of unchanged data become free (phase-02 §21).
 * That starts paying immediately and compounds through every later phase.
 */

/** Entries are kept for a day. An ETag never "expires", but unbounded cache growth does
 * need a ceiling, and a stale entry costs nothing worse than one full response. */
export const ETAG_CACHE_TTL_SECONDS = 24 * 60 * 60;

export interface EtagCacheEntry {
  etag: string;
  data: unknown;
}

/**
 * Storage for ETag entries, behind an interface for the same reason TokenCache is: the
 * tests must run with no Redis. `TokenCacheEtagStore` below adapts any `TokenCache` to it.
 */
export interface EtagStore {
  get(key: string): Promise<EtagCacheEntry | null>;
  set(key: string, entry: EtagCacheEntry, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Cache key. **Scoped by installation, deliberately.** Two installations can get
 * different bodies for the same URL — one may see a private repository the other cannot —
 * so a key without the installation in it would let one tenant's installation serve
 * another's cached response. That would be a data-leak bug, not a cache-tuning detail.
 */
export function etagCacheKey(scope: string, method: string, url: string): string {
  return `gh:etag:${scope}:${method.toUpperCase()}:${url}`;
}

/** Adapts a TokenCache (opaque string values) into an EtagStore by JSON round-tripping. */
export class TokenCacheEtagStore implements EtagStore {
  constructor(private readonly cache: TokenCache) {}

  async get(key: string): Promise<EtagCacheEntry | null> {
    const raw = await this.cache.get(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as EtagCacheEntry;
      return typeof parsed?.etag === "string" ? parsed : null;
    } catch {
      // A corrupt entry is a cache miss, never an error: the worst case is one full
      // fetch, and throwing here would break requests over a bad cache write.
      return null;
    }
  }

  async set(key: string, entry: EtagCacheEntry, ttlSeconds: number): Promise<void> {
    await this.cache.set(key, JSON.stringify(entry), ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.cache.delete(key);
  }
}

export interface EtagCachePluginOptions {
  store: EtagStore;
  /** Namespace for keys — the installation id. See etagCacheKey above. */
  scope: string;
  logger?: Logger;
  ttlSeconds?: number;
}

interface MaybeRequestError {
  status?: number;
}

/**
 * Builds the Octokit plugin.
 *
 * **Register this plugin FIRST**, so its wrap sits innermost — closest to the real
 * request. @octokit/request throws a `RequestError` with `status: 304` rather than
 * returning one (verified in the installed @octokit/request@10.0.15's fetch-wrapper.js),
 * and that throw must be converted back into a successful response *before* the retry
 * plugin's error hook ever sees it. Outermost registration would have the retry plugin
 * treat every cache hit as a failed request.
 */
export function createEtagCachePlugin(options: EtagCachePluginOptions) {
  const logger = options.logger ?? createLogger("github.client");
  const ttlSeconds = options.ttlSeconds ?? ETAG_CACHE_TTL_SECONDS;

  return function etagCachePlugin(octokit: Octokit): void {
    octokit.hook.wrap("request", async (request, requestOptions) => {
      // Conditional requests only make sense for reads. A cached ETag on a mutation
      // would be meaningless at best and would suppress a write at worst.
      if ((requestOptions.method ?? "GET").toUpperCase() !== "GET") {
        return request(requestOptions);
      }

      const parsed = octokit.request.endpoint.parse(requestOptions);
      const key = etagCacheKey(options.scope, parsed.method, parsed.url);
      const cached = await options.store.get(key);

      if (cached) {
        requestOptions.headers = { ...requestOptions.headers, "if-none-match": cached.etag };
      }

      try {
        const response = await request(requestOptions);
        const etag = response.headers?.etag;
        if (typeof etag === "string" && etag.length > 0) {
          await options.store.set(key, { etag, data: response.data }, ttlSeconds);
        }
        return response;
      } catch (error) {
        if (cached && (error as MaybeRequestError)?.status === 304) {
          logger.debug("github etag cache hit — 304, response served from cache", {
            endpoint: parsed.url,
            method: parsed.method,
            status: 304,
            cacheKey: key,
            cache: "hit",
          });
          // A 304 carries no body. Serve the cached one and present it as the 200 the
          // caller would have received, so no call site has to know caching exists.
          // `retryCount` is required on OctokitResponse once @octokit/plugin-throttling
          // is installed (it augments the type) — a cache hit made zero attempts.
          return { status: 200, url: parsed.url, headers: { etag: cached.etag }, data: cached.data, retryCount: 0 };
        }
        throw error;
      }
    });
  };
}
