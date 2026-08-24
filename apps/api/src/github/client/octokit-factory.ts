import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import type { EndpointDefaults } from "@octokit/types";
import { createLogger, type Logger } from "../../lib/logger.js";
import { getInstallationToken } from "./app-auth.js";
import { createEtagCachePlugin, TokenCacheEtagStore, type EtagStore } from "./etag-cache.js";
import { getTokenCache } from "./redis.js";
import { createRateLimitPolicy } from "./rate-limiter.js";
import type { TokenCache } from "./token-cache.js";

/**
 * The single Octokit constructor every later phase reuses. Nothing else in the system
 * builds an Octokit instance directly.
 *
 * Plugin registration order is load-bearing. before-after-hook applies registered wraps
 * outward-in — the *last* registered wrap is outermost (verified in the installed
 * before-after-hook@4.0.0's register.js reduce). So:
 *
 *   etagCache  (innermost) — must convert @octokit/request's `304` *throw* back into a
 *                            success before any error hook sees it
 *   retry                  — 5xx/network retries
 *   throttling             — primary/secondary rate limits
 *   logging    (outermost) — records the final outcome of the request, after retries
 */

/** Named so the logging wrap and every call site agree on the component (§20). */
export const GITHUB_CLIENT_COMPONENT = "github.client";

export interface OctokitFactoryOptions {
  /** Overrides token minting. Injected by tests; production goes through app-auth. */
  getToken?: (installationId: bigint) => Promise<string>;
  /** Storage for ETag entries. Defaults to the shared Redis-backed token cache. */
  etagStore?: EtagStore;
  cache?: TokenCache;
  logger?: Logger;
  baseUrl?: string;
  /** Passed straight through to Octokit's `request` options — this is the fetch seam. */
  fetch?: typeof fetch;
  maxRateLimitWaitSeconds?: number;
}

/**
 * Records one line per request with the fields §20 requires: component, installationId,
 * endpoint, status, and — on failure — the raw `x-ratelimit-remaining` as a number, not
 * interpolated into a message. Registered last so it observes the outcome *after* the
 * retry and throttling plugins have had their say.
 */
function createLoggingPlugin(installationId: bigint, logger: Logger) {
  const installation = installationId.toString();

  return function loggingPlugin(octokit: Octokit): void {
    octokit.hook.wrap("request", async (request, requestOptions) => {
      const endpoint = `${requestOptions.method} ${requestOptions.url}`;
      try {
        const response = await request(requestOptions);
        logger.info("github request completed", {
          installationId: installation,
          endpoint,
          status: response.status,
          "github.rate_limit_remaining": Number(response.headers?.["x-ratelimit-remaining"] ?? Number.NaN),
        });
        return response;
      } catch (error) {
        const failure = error as { status?: number; response?: { headers?: Record<string, string> } };
        logger.warn("github request failed", {
          installationId: installation,
          endpoint,
          status: failure.status ?? 0,
          "github.rate_limit_remaining": Number(failure.response?.headers?.["x-ratelimit-remaining"] ?? Number.NaN),
        });
        throw error;
      }
    });
  };
}

/**
 * Authenticates every request with a *freshly resolved* installation token rather than
 * one captured at construction.
 *
 * This is why the factory can hand back an instance that stays valid: the token is read
 * from app-auth (and therefore from the 50-minute cache) at request time, so an Octokit
 * held across the expiry boundary picks up the new token instead of sending a dead one.
 * The alternative — `new Octokit({ auth: token })` — bakes in a token that silently rots.
 */
function createAuthPlugin(installationId: bigint, getToken: (installationId: bigint) => Promise<string>) {
  return function authPlugin(octokit: Octokit): void {
    octokit.hook.before("request", async (requestOptions) => {
      const token = await getToken(installationId);
      requestOptions.headers = { ...requestOptions.headers, authorization: `token ${token}` };
    });
  };
}

/**
 * Builds an Octokit scoped to one GitHub App installation.
 *
 * Async only because nothing here needs to be — it is kept synchronous deliberately: no
 * token is minted at construction, so building a client never costs a GitHub call.
 */
export function createInstallationOctokit(installationId: bigint, options: OctokitFactoryOptions = {}): Octokit {
  const logger = options.logger ?? createLogger(GITHUB_CLIENT_COMPONENT);
  const getToken = options.getToken ?? getInstallationToken;
  const etagStore = options.etagStore ?? new TokenCacheEtagStore(options.cache ?? getTokenCache());

  const etagCache = createEtagCachePlugin({ store: etagStore, scope: installationId.toString(), logger });

  const ClientConstructor = Octokit.plugin(
    etagCache,
    retry,
    throttling,
    createAuthPlugin(installationId, getToken),
    createLoggingPlugin(installationId, logger),
  );

  return new ClientConstructor({
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    request: options.fetch ? { fetch: options.fetch } : {},
    retry: {
      // Defaults verified from the installed @octokit/plugin-retry@8.1.1: retries 3,
      // doNotRetry [400,401,403,404,410,422,451]. 304 is added because the ETag plugin
      // relies on a 304 *throw* reaching it — if a future change ever registers the
      // plugins in a different order, retrying the 304 would be a silent regression.
      doNotRetry: [304, 400, 401, 403, 404, 410, 422, 451],
    },
    throttle: createRateLimitPolicy({
      installationId,
      logger,
      ...(options.maxRateLimitWaitSeconds !== undefined ? { maxWaitSeconds: options.maxRateLimitWaitSeconds } : {}),
    }),
    log: {
      // Octokit's own internal logging is routed into the structured logger rather than
      // console (no-console is an error repo-wide).
      debug: (message: string) => logger.debug(message, { source: "octokit" }),
      info: (message: string) => logger.debug(message, { source: "octokit" }),
      warn: (message: string) => logger.warn(message, { source: "octokit" }),
      error: (message: string) => logger.warn(message, { source: "octokit" }),
    },
  });
}

export type { EndpointDefaults };
