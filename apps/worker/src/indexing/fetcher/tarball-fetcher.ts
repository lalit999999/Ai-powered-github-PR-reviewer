import {
  GithubAccessRevokedError,
  GithubRateLimitError,
  getInstallationToken,
} from "@repo/github";
import { createLogger, type Logger } from "@repo/observability";

/**
 * Fetches a repository's tarball as a stream. Responsibility is deliberately narrow:
 * given an already-resolved `(installationId, owner, repo, sha)`, produce a byte
 * stream of `GET /repos/{owner}/{repo}/tarball/{sha}`'s eventual response. It does not
 * resolve the SHA (the caller — Prompt 2's `repository-index` Inngest step 2 — already
 * has it), extract, filter, or persist anything (archive-extractor.ts and Prompt 2's
 * indexer own that).
 *
 * ## Why this is a raw `fetch`, not an Octokit `request()` call
 *
 * Verified by reading the installed @octokit/request@10.0.15's `fetch-wrapper.js` rather
 * than assuming — and the first assumption tried here was wrong, which is exactly why:
 * `requestOptions.request.redirect` *is* forwarded to the underlying `fetch`, so
 * `octokit.request(url, { request: { redirect: "manual" } })` is a real, usable option;
 * a 3xx response is returned as a normal (non-throwing) `OctokitResponse` with no special
 * handling in between. And a full-URL request through `octokit.request()` *can* be told
 * not to buffer the body — `request: { parseSuccessResponseBody: false }` sets
 * `response.data = fetchResponse.body`, the raw stream, instead of the default path
 * (`getResponseData()`), which — for a non-JSON, non-`text/*` content type like a
 * tarball's `application/x-gzip` — calls `response.arrayBuffer()` and *would* buffer the
 * whole archive in memory, exactly the anti-pattern §4 Security rules out, if that
 * default were left in place.
 *
 * So both problems have an Octokit-native fix. What doesn't: `createAuthPlugin`
 * (octokit-factory.ts) installs a `hook.before("request", …)` that attaches the
 * installation's bearer token to *every* request made through that Octokit instance,
 * unconditionally — including a full-URL request to `codeload.github.com`. That URL is
 * already self-authenticating (a signed, credentialed query string is the entire point
 * of the redirect), so attaching an additional `Authorization: token …` header to it
 * would send the App's installation token to a second host for no reason, widening
 * exactly the credential surface §4/§35.9 exist to narrow — and there is no per-request
 * way to suppress one plugin's hook for one call without constructing a second,
 * differently-configured Octokit instance, which is its own complication for a
 * two-call, one-shot fetch. A raw `fetch` sends the token to `api.github.com` for the
 * first call and nothing but the signed URL's own query string for the second, with no
 * plugin stack (retry, throttling, ETag caching — none of which are meaningful for a
 * large one-shot binary stream) to reason about in between.
 *
 * ## Error handling
 *
 * `getInstallationToken` can itself throw `GithubAccessRevokedError` / `GithubRateLimitError`
 * / (`@repo/github`'s own) `ServiceUnavailableError` — those propagate unchanged; this
 * module does not catch and reclassify them, so the caller sees exactly what app-auth.ts
 * already decided.
 *
 * For the tarball request itself, this module classifies explicitly rather than reusing
 * `github-result.ts`'s `classifyGithubError` — that helper inspects Octokit's own thrown
 * error shape (`error.status`, `error.response.headers`), which a raw `fetch` response
 * never produces. The *outcome vocabulary* is reused instead: a 404 becomes the result
 * variant `REPO_NOT_FOUND` (§12's own `indexError.code`), and 401 / 403-with-rate-limit /
 * 403-without-rate-limit reuse `GithubAccessRevokedError` / `GithubRateLimitError` by
 * throwing them directly — the same two classes app-auth.ts throws for the identical
 * underlying conditions, so a caller catching them once catches both call sites.
 *
 * ## Why 5xx/network failures are a single fetch attempt, not a 3-attempt loop
 *
 * app-auth.ts's `mint()` retries 3 times internally because it is called from a
 * request/response HTTP handler with no outer retry mechanism of its own. This module is
 * called from an Inngest step (Prompt 2), which already retries the whole step on a
 * thrown error (`plan.md` §27: `repository-index`'s own `retries: 3`). Retrying inside
 * *and* outside would multiply attempts (up to 3×3) against a phase document that states
 * the budget as exactly 3. So a 5xx or network failure here is a single attempt that
 * throws a plain `Error` and lets the caller's retry mechanism own the backoff — see
 * docs/decisions/phase-03-log.md for the fuller argument.
 */

const GITHUB_API_BASE_URL = "https://api.github.com";
const CODELOAD_HOST = "codeload.github.com";

/** Matches octokit-factory.ts's `createLoggingPlugin` component/field shape exactly
 * (endpoint, status, github.rate_limit_remaining) so a log-line count across both the
 * Octokit-issued metadata call and this module's two raw calls proves §15's "exactly two
 * GitHub API calls per full index run" acceptance signal the same way, regardless of
 * which HTTP path issued the request. */
export const TARBALL_FETCHER_COMPONENT = "github.client";

export interface TarballFetchOptions {
  logger?: Logger;
  /** Test seam; production uses the global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam; production resolves through @repo/github's cache. */
  getToken?: (installationId: bigint) => Promise<string>;
  baseUrl?: string;
}

export type TarballFetchResult =
  | { ok: true; stream: ReadableStream<Uint8Array> }
  | { ok: false; reason: "REPO_NOT_FOUND" }
  /** The 302 pointed somewhere other than codeload.github.com. Rejected before it is
   * ever followed — this is the SSRF defense (plan.md §35.9), not a GitHub-side failure,
   * so it does not reuse GithubResult's vocabulary. Non-retriable: a different host on
   * retry would mean GitHub's redirect target changed, which is not a transient fault. */
  | { ok: false; reason: "UNSAFE_REDIRECT"; host: string };

function rateLimitResetAtSeconds(
  headers: Headers,
  nowMs: number,
): number | null {
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter;
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(reset)) return null;
  return Math.max(0, Math.ceil((reset * 1000 - nowMs) / 1000));
}

function isRateLimited(headers: Headers): boolean {
  return (
    headers.get("x-ratelimit-remaining") === "0" ||
    headers.get("retry-after") !== null
  );
}

function logCompleted(
  logger: Logger,
  installationId: bigint,
  endpoint: string,
  status: number,
  headers: Headers,
): void {
  logger.info("github request completed", {
    installationId: installationId.toString(),
    endpoint,
    status,
    "github.rate_limit_remaining": Number(
      headers.get("x-ratelimit-remaining") ?? Number.NaN,
    ),
  });
}

function logFailed(
  logger: Logger,
  installationId: bigint,
  endpoint: string,
  status: number,
  headers: Headers,
): void {
  logger.warn("github request failed", {
    installationId: installationId.toString(),
    endpoint,
    status,
    "github.rate_limit_remaining": Number(
      headers.get("x-ratelimit-remaining") ?? Number.NaN,
    ),
  });
}

/**
 * `GET /repos/{owner}/{repo}/tarball/{sha}` — the one API call this phase spends on
 * fetching content (§9/§15). Streams the response; never awaits `.arrayBuffer()`/`.text()`.
 */
export async function fetchTarballStream(
  installationId: bigint,
  owner: string,
  repo: string,
  sha: string,
  options: TarballFetchOptions = {},
): Promise<TarballFetchResult> {
  const logger = options.logger ?? createLogger(TARBALL_FETCHER_COMPONENT);
  const doFetch = options.fetchImpl ?? fetch;
  const getToken = options.getToken ?? getInstallationToken;
  const baseUrl = options.baseUrl ?? GITHUB_API_BASE_URL;
  const endpointTemplate = "GET /repos/{owner}/{repo}/tarball/{sha}";

  // Propagates GithubAccessRevokedError / GithubRateLimitError / ServiceUnavailableError
  // unchanged on failure — see this module's header comment.
  const token = await getToken(installationId);

  const firstResponse = await doFetch(
    `${baseUrl}/repos/${owner}/${repo}/tarball/${sha}`,
    {
      method: "GET",
      redirect: "manual",
      headers: {
        authorization: `token ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );

  // A 3xx with `redirect: "manual"` resolves (rather than throwing) with the redirect
  // response itself and a readable Location header — verified empirically against the
  // installed Node 22 / undici fetch (docs/decisions/phase-03-log.md records the check);
  // browsers' `redirect: "manual"` instead yields an opaque, unreadable response, which
  // is a real behavioral difference worth having actually checked rather than assumed.
  if (firstResponse.status >= 300 && firstResponse.status < 400) {
    const location = firstResponse.headers.get("location");
    const target = location ? safeParseUrl(location) : null;

    if (!target || target.hostname !== CODELOAD_HOST) {
      logFailed(
        logger,
        installationId,
        endpointTemplate,
        firstResponse.status,
        firstResponse.headers,
      );
      logger.warn(
        "tarball redirect target rejected — not the pinned codeload host",
        {
          installationId: installationId.toString(),
          // The host only — never the full URL, which carries a signed, credentialed
          // query string (§4 Security: no secret ever reaches a log line).
          redirectHost: target?.hostname ?? null,
        },
      );
      return {
        ok: false,
        reason: "UNSAFE_REDIRECT",
        host: target?.hostname ?? "unknown",
      };
    }

    logCompleted(
      logger,
      installationId,
      endpointTemplate,
      firstResponse.status,
      firstResponse.headers,
    );
    logger.info("following pinned tarball redirect", {
      installationId: installationId.toString(),
      redirectHost: target.hostname,
    });

    // `redirect: "error"` on this second call is the enforcement half of "one hop and no
    // further" — if codeload.github.com itself ever answered with another redirect, this
    // throws rather than silently chasing it (verified: a fetch that would redirect under
    // `redirect: "error"` rejects with a TypeError instead of resolving).
    const secondResponse = await doFetch(target.toString(), {
      method: "GET",
      redirect: "error",
    });

    if (!secondResponse.ok || !secondResponse.body) {
      logFailed(
        logger,
        installationId,
        "GET codeload.github.com",
        secondResponse.status,
        secondResponse.headers,
      );
      throw new Error(
        `codeload.github.com responded ${secondResponse.status.toString()} fetching the tarball`,
      );
    }

    logCompleted(
      logger,
      installationId,
      "GET codeload.github.com",
      secondResponse.status,
      secondResponse.headers,
    );
    return { ok: true, stream: secondResponse.body };
  }

  // Everything below is a non-redirect response to the *first* call — GitHub answered
  // directly rather than pointing at codeload, which for this endpoint means a failure.
  const { status, headers } = firstResponse;

  if (status === 404) {
    logFailed(logger, installationId, endpointTemplate, status, headers);
    return { ok: false, reason: "REPO_NOT_FOUND" };
  }

  if (status === 401) {
    logFailed(logger, installationId, endpointTemplate, status, headers);
    throw new GithubAccessRevokedError(
      "GitHub access was revoked — reinstall the app",
      {
        details: { installationId: installationId.toString() },
      },
    );
  }

  if ((status === 403 || status === 429) && isRateLimited(headers)) {
    const resetAtSeconds = rateLimitResetAtSeconds(headers, Date.now());
    logFailed(logger, installationId, endpointTemplate, status, headers);
    throw new GithubRateLimitError(
      "GitHub's rate limit for this app is exhausted — try again shortly",
      {
        details: {
          installationId: installationId.toString(),
          retryAfterSeconds: resetAtSeconds,
        },
      },
    );
  }

  if (status === 403) {
    // 403 without rate-limit headers, same classification app-auth.ts uses for the
    // identical ambiguity on the token-mint call: suspended or gone, not busy.
    logFailed(logger, installationId, endpointTemplate, status, headers);
    throw new GithubAccessRevokedError(
      "GitHub access was revoked — reinstall the app",
      {
        details: { installationId: installationId.toString(), status },
      },
    );
  }

  logFailed(logger, installationId, endpointTemplate, status, headers);
  throw new Error(
    `GitHub responded ${status.toString()} fetching the tarball for ${owner}/${repo}@${sha}`,
  );
}

function safeParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
