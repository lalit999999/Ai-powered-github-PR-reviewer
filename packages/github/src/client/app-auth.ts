import { createAppAuth } from "@octokit/auth-app";
import { env } from "../../config/env.js";
import { GithubAccessRevokedError, GithubRateLimitError, ServiceUnavailableError } from "../../lib/errors.js";
import { createLogger, type Logger } from "../../lib/logger.js";
import { getTokenCache } from "./redis.js";
import type { Clock, TokenCache } from "./token-cache.js";

/**
 * The one place in the system that turns the GitHub App private key into a usable
 * installation access token. Every GitHub call in every later phase goes through it.
 *
 * Nothing outside this module ever sees the App JWT, the private key, or the cache —
 * the exported surface is `getInstallationToken(installationId)` and nothing else.
 */

/**
 * How long a minted token may be reused. GitHub's own expiry is 60 minutes; the
 * 10-minute margin exists so a token cannot expire *mid-call* (phase-02 §4 Reliability).
 *
 * Exported because plan.md §45 names installation-token expiry off-by-one as a failure
 * point for this phase, and §22 requires a boundary test at 49:59 / 50:01. The test
 * references this constant rather than repeating `50`, so the two cannot drift apart —
 * a duplicated literal is precisely how an off-by-one survives its own regression test.
 */
export const TOKEN_CACHE_TTL_SECONDS = 50 * 60;

/**
 * Shaved off GitHub's stated `expires_at` when that is the binding constraint. Clock
 * skew between this host and GitHub is real, so even a server-stated expiry gets a
 * margin before we consider a token reusable.
 */
export const TOKEN_EXPIRY_SAFETY_MARGIN_SECONDS = 60;

/** 5xx/network retries, per phase-02 §12 ("Yes, 3 attempts"). Total attempts, not extras. */
export const TOKEN_MINT_MAX_ATTEMPTS = 3;

/** First backoff delay; doubles per attempt (250ms, 500ms). Deliberately short — a user
 * is waiting on the far end of a connect request, not a background job. */
export const TOKEN_MINT_BASE_BACKOFF_MS = 250;

/** Above this, waiting out a rate-limit reset inside a request is worse than failing
 * fast and letting the caller retry. GitHub's primary-limit resets can be an hour away. */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 30;

const GITHUB_API_BASE_URL = "https://api.github.com";

/** Cache key namespace. Keyed on installationId alone: a token is scoped to exactly
 * one installation and is identical for every project using it. */
export function installationTokenCacheKey(installationId: bigint): string {
  return `gh:installation-token:${installationId.toString()}`;
}

export interface GithubHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface GithubHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/**
 * The HTTP seam. A function, not an Octokit instance, for two reasons: the unit suite
 * stubs it with three lines instead of a mock server, and — more importantly — an
 * Octokit instance here would be circular, since octokit-factory.ts authenticates
 * *using* this module.
 */
export type GithubHttpClient = (request: GithubHttpRequest) => Promise<GithubHttpResponse>;

export interface InstallationTokenServiceOptions {
  cache?: TokenCache;
  http?: GithubHttpClient;
  /** Returns a signed App JWT. Injectable so tests never need a real RSA key. */
  createAppJwt?: () => Promise<string>;
  now?: Clock;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  baseUrl?: string;
}

export interface InstallationTokenService {
  getInstallationToken(installationId: bigint): Promise<string>;
  /** Drops a cached token — used when a caller learns the token is no longer good. */
  invalidate(installationId: bigint): Promise<void>;
}

interface AccessTokenResponseBody {
  token?: unknown;
  expires_at?: unknown;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default HTTP client over global fetch (Node 22 — no polyfill needed). Header names are
 * lower-cased on the way out so every downstream read is case-insensitive by construction;
 * `Headers` already normalizes, but the record we hand on must too.
 */
const defaultHttp: GithubHttpClient = async ({ method, url, headers }) => {
  const response = await fetch(url, { method, headers });
  const headerRecord: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headerRecord[key.toLowerCase()] = value;
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body (GitHub's HTML error pages, a proxy's plain-text 502) is still
    // useful for diagnostics — keep it rather than discarding it.
    body = text;
  }
  return { status: response.status, headers: headerRecord, body };
};

/**
 * App JWT generation, delegated to @octokit/auth-app rather than hand-rolled.
 *
 * Verified against the installed @octokit/auth-app@8.3.0's own source, not the docs:
 * `createAppAuth({ appId, privateKey })` returns an AuthInterface, and
 * `auth({ type: "app" })` resolves to `{ type, token, appId, expiresAt }` where `token`
 * is the RS256-signed JWT. It signs via universal-github-app-jwt@2.2.2, which backdates
 * `iat` by 30s for clock skew and sets `exp` to iat+10min — GitHub's maximum — and which
 * converts a PKCS#1 key (GitHub's default .pem) to PKCS#8 on Node before handing it to
 * WebCrypto. That is why config.ts accepts both PEM types.
 *
 * The installation-token exchange below is deliberately NOT delegated to the same
 * library: auth-app keeps its own in-memory LRU of installation tokens with its own
 * expiry rules, which would sit underneath this module's Redis cache and quietly own
 * the very expiry boundary phase-02 §22 requires us to test.
 */
function defaultCreateAppJwt(): () => Promise<string> {
  const auth = createAppAuth({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY });
  return async () => {
    const appAuthentication = await auth({ type: "app" });
    return appAuthentication.token;
  };
}

function parseExpiresAtMs(body: unknown): number | null {
  const expiresAt = (body as AccessTokenResponseBody | null)?.expires_at;
  if (typeof expiresAt !== "string") return null;
  const parsed = Date.parse(expiresAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Effective cache TTL: `min(50 minutes, expires_at − now − safety margin)`.
 *
 * Trusting GitHub's stated `expires_at` over local "it's always 60 minutes" arithmetic
 * is strictly safer — if this host's clock runs behind GitHub's, a token assumed good
 * for 50 more minutes may already be dead. Exported for the boundary test.
 */
export function effectiveTtlSeconds(expiresAtMs: number | null, nowMs: number): number {
  if (expiresAtMs === null) return TOKEN_CACHE_TTL_SECONDS;
  const remaining = Math.floor((expiresAtMs - nowMs) / 1000) - TOKEN_EXPIRY_SAFETY_MARGIN_SECONDS;
  return Math.max(0, Math.min(TOKEN_CACHE_TTL_SECONDS, remaining));
}

function rateLimitWaitSeconds(headers: Record<string, string>, nowMs: number): number | null {
  const retryAfter = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter;

  const reset = Number(headers["x-ratelimit-reset"]);
  if (!Number.isFinite(reset)) return null;
  return Math.max(0, Math.ceil((reset * 1000 - nowMs) / 1000));
}

/**
 * A 403 is ambiguous at GitHub: it means "rate limited" *or* "installation suspended".
 * The rate-limit headers are what tell them apart, and getting this wrong in the
 * revocation direction would mark a perfectly healthy repository ACCESS_LOST every time
 * the App got busy (phase-02 §12).
 */
function isRateLimited(headers: Record<string, string>): boolean {
  return headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] !== undefined;
}

export function createInstallationTokenService(options: InstallationTokenServiceOptions = {}): InstallationTokenService {
  const logger = options.logger ?? createLogger("github.client");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const http = options.http ?? defaultHttp;
  const baseUrl = options.baseUrl ?? GITHUB_API_BASE_URL;
  let createAppJwt = options.createAppJwt;
  let cache = options.cache;

  // Both are resolved on first use, not at construction: importing this module must not
  // build an RSA signer or open a Redis connection.
  const resolveJwtFactory = () => (createAppJwt ??= defaultCreateAppJwt());
  const resolveCache = () => (cache ??= getTokenCache());

  async function mintOnce(installationId: bigint, endpoint: string): Promise<GithubHttpResponse> {
    const jwt = await resolveJwtFactory()();
    return http({
      method: "POST",
      url: `${baseUrl}${endpoint}`,
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
  }

  async function mint(installationId: bigint): Promise<{ token: string; ttlSeconds: number }> {
    const endpoint = `/app/installations/${installationId.toString()}/access_tokens`;
    let lastFailure: string = "no attempt made";

    for (let attempt = 1; attempt <= TOKEN_MINT_MAX_ATTEMPTS; attempt += 1) {
      let response: GithubHttpResponse;
      try {
        response = await mintOnce(installationId, endpoint);
      } catch (error) {
        // Network-level failure (DNS, TCP, TLS, abort) — same class as a 5xx: retry.
        lastFailure = error instanceof Error ? error.message : String(error);
        logger.warn("installation token mint failed at the network layer", {
          installationId: installationId.toString(),
          endpoint,
          attempt,
          error: lastFailure,
        });
        if (attempt === TOKEN_MINT_MAX_ATTEMPTS) break;
        await sleep(TOKEN_MINT_BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }

      const { status, headers } = response;
      // §20: the raw rate-limit number is a structured field, never interpolated into
      // the message — Phase 16's dashboard reads github.rate_limit_remaining from here.
      const rateLimitFields = {
        installationId: installationId.toString(),
        endpoint,
        status,
        attempt,
        "github.rate_limit_remaining": Number(headers["x-ratelimit-remaining"] ?? Number.NaN),
      };

      if (status >= 200 && status < 300) {
        const token = (response.body as AccessTokenResponseBody | null)?.token;
        if (typeof token !== "string" || token.length === 0) {
          // A 2xx with no token is not retryable and is not revocation — it means we do
          // not understand the response, which is a bug, not a transient fault.
          throw new ServiceUnavailableError("GitHub returned an unexpected response while minting an installation token", {
            details: { installationId: installationId.toString() },
          });
        }
        const ttlSeconds = effectiveTtlSeconds(parseExpiresAtMs(response.body), now());
        logger.info("installation token minted", { ...rateLimitFields, cache: "miss", ttlSeconds });
        return { token, ttlSeconds };
      }

      if (status === 401) {
        // Never retried: the installation was revoked, deleted, or suspended, and a
        // second identical request cannot change that (phase-02 §12).
        logger.warn("installation token mint rejected — installation access lost", { ...rateLimitFields, retried: false });
        throw new GithubAccessRevokedError("GitHub access was revoked — reinstall the app", {
          details: { installationId: installationId.toString() },
        });
      }

      if ((status === 403 || status === 429) && isRateLimited(headers)) {
        const waitSeconds = rateLimitWaitSeconds(headers, now());
        logger.warn("installation token mint rate limited", { ...rateLimitFields, waitSeconds });
        // Deliberately not a retry loop here. This module is called from inside a
        // user-facing request; sleeping out a primary-limit reset (up to an hour) would
        // hold the connection open for the whole window. octokit-factory.ts schedules
        // short waits for ordinary API calls; a rate-limited *mint* fails fast with the
        // wait time attached so the caller can decide.
        throw new GithubRateLimitError("GitHub's rate limit for this app is exhausted — try again shortly", {
          details: { installationId: installationId.toString(), retryAfterSeconds: waitSeconds },
        });
      }

      if (status === 403 || status === 404) {
        // 403 without rate-limit headers, or 404: the installation is suspended or gone.
        logger.warn("installation token mint rejected — installation unavailable", { ...rateLimitFields, retried: false });
        throw new GithubAccessRevokedError("GitHub access was revoked — reinstall the app", {
          details: { installationId: installationId.toString(), status },
        });
      }

      lastFailure = `GitHub responded ${status}`;
      logger.warn("installation token mint failed", rateLimitFields);
      if (status < 500) {
        // Any other 4xx is a request we got wrong; retrying it identically is pointless.
        break;
      }
      if (attempt === TOKEN_MINT_MAX_ATTEMPTS) break;
      await sleep(TOKEN_MINT_BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }

    throw new ServiceUnavailableError("GitHub is temporarily unavailable, try again", {
      details: { installationId: installationId.toString(), attempts: TOKEN_MINT_MAX_ATTEMPTS, lastFailure },
    });
  }

  return {
    async getInstallationToken(installationId: bigint): Promise<string> {
      const key = installationTokenCacheKey(installationId);
      const cached = await resolveCache().get(key);
      if (cached) {
        // Hit and miss are logged as distinct events (§20) — this is the signal §14 asks
        // to check when verifying that two calls in quick succession reuse one token.
        logger.debug("installation token cache hit", { installationId: installationId.toString(), cacheKey: key, cache: "hit" });
        return cached;
      }

      const { token, ttlSeconds } = await mint(installationId);
      if (ttlSeconds > 0) {
        await resolveCache().set(key, token, ttlSeconds);
      }
      return token;
    },

    async invalidate(installationId: bigint): Promise<void> {
      await resolveCache().delete(installationTokenCacheKey(installationId));
    },
  };
}

let defaultService: InstallationTokenService | undefined;

/**
 * The narrow surface every caller uses. Callers never see the JWT, the cache, or the
 * private key — just a token string that is valid right now.
 */
export function getInstallationToken(installationId: bigint): Promise<string> {
  defaultService ??= createInstallationTokenService();
  return defaultService.getInstallationToken(installationId);
}

/** Drops the cached token for an installation. */
export function invalidateInstallationToken(installationId: bigint): Promise<void> {
  defaultService ??= createInstallationTokenService();
  return defaultService.invalidate(installationId);
}
