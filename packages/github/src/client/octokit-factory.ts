import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import type { EndpointDefaults } from "@octokit/types";
import { createLogger, type Logger } from "@repo/observability";
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
function createLoggingPlugin(installationId: bigint | null, logger: Logger) {
  // `null` for the one call in the system made with a *user* OAuth token rather than
  // an installation token (GET /user/installations) — see createUserOctokit. The field
  // is still emitted, so a log query filtering on `installationId` sees an explicit
  // null rather than a missing key.
  const installation = installationId === null ? null : installationId.toString();

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

export interface UserOctokitOptions {
  logger?: Logger;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxRateLimitWaitSeconds?: number;
}

/**
 * The **only** Octokit in this system authenticated as a *user* rather than as an App
 * installation.
 *
 * phase-02 §9 has exactly one such call — `GET /user/installations`, which answers
 * "which installations can this signed-in person see". That question is about the
 * human, so an installation token cannot answer it; every other GitHub call in the
 * product uses `createInstallationOctokit` above. Getting these two backwards is
 * `plan.md` §45's "App installation ≠ OAuth identity" failure point wearing a
 * different hat, which is why the two constructors are named for their credential and
 * live side by side.
 *
 * No ETag cache: that cache is keyed by installation (etag-cache.ts scopes entries so
 * one tenant's installation can never serve another's body), and there is no
 * installation here to key on. Caching this response under the *user's* token would
 * need a second, differently-scoped key space for one small, rarely-repeated call.
 *
 * The token is passed to Octokit and never logged — `logger.ts`'s redaction covers
 * `token`/`accessToken`-shaped keys, and nothing here puts it in a log payload anyway.
 */
export function createUserOctokit(accessToken: string, options: UserOctokitOptions = {}): Octokit {
  const logger = options.logger ?? createLogger(GITHUB_CLIENT_COMPONENT);

  const ClientConstructor = Octokit.plugin(retry, throttling, createLoggingPlugin(null, logger));

  return new ClientConstructor({
    auth: accessToken,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    request: options.fetch ? { fetch: options.fetch } : {},
    retry: { doNotRetry: [304, 400, 401, 403, 404, 410, 422, 451] },
    throttle: createRateLimitPolicy({
      installationId: null,
      logger,
      ...(options.maxRateLimitWaitSeconds !== undefined ? { maxWaitSeconds: options.maxRateLimitWaitSeconds } : {}),
    }),
    log: {
      debug: (message: string) => logger.debug(message, { source: "octokit" }),
      info: (message: string) => logger.debug(message, { source: "octokit" }),
      warn: (message: string) => logger.warn(message, { source: "octokit" }),
      error: (message: string) => logger.warn(message, { source: "octokit" }),
    },
  });
}

export type { EndpointDefaults };
