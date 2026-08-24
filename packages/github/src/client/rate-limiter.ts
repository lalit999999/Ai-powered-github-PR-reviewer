import type { Octokit } from "@octokit/core";
import type { EndpointDefaults } from "@octokit/types";
import { createLogger, type Logger } from "../../lib/logger.js";

/**
 * Rate-limit policy for the GitHub client, expressed as @octokit/plugin-throttling's
 * handlers.
 *
 * The plugin's option shape was verified against the installed
 * @octokit/plugin-throttling@11.0.5's own source: it **throws at construction** unless
 * both `onRateLimit` and `onSecondaryRateLimit` are functions, and each handler is
 * `(retryAfter, options, octokit, retryCount)` returning `true` to schedule a retry.
 * Returning nothing means "give up", which surfaces as the original error.
 */

/**
 * The ceiling on how long the client will sit and wait for a rate limit to reset.
 *
 * GitHub's primary limit resets on a fixed hourly window, so `x-ratelimit-reset` can be
 * up to an hour out. Sleeping that long inside a user-facing HTTP request is never the
 * right answer — the connection would be held open, the user would see nothing, and any
 * proxy in front would time it out anyway. Above this threshold the client fails fast
 * with the wait time attached and lets the caller decide (phase-02 §12/§14).
 */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 30;

/** How many times a single request may be rescheduled before giving up. */
export const MAX_RATE_LIMIT_RETRIES = 2;

export interface RateLimitPolicyOptions {
  /** `null` for the user-OAuth client (createUserOctokit) — there is no installation
   * behind `GET /user/installations`. Logged as an explicit null rather than omitted. */
  installationId: bigint | null;
  logger?: Logger;
  maxWaitSeconds?: number;
  maxRetries?: number;
}

function endpointOf(options: Required<EndpointDefaults>): string {
  return `${options.method} ${options.url}`;
}

/**
 * Builds the `throttle` option block for `new Octokit({ throttle })`.
 *
 * Both handlers log before deciding, so a rate-limit event is visible whether or not it
 * was retried — §20 wants the raw `github.rate_limit_remaining` number available as a
 * structured field for Phase 16's dashboard, not buried in a message string.
 */
export function createRateLimitPolicy(options: RateLimitPolicyOptions) {
  const logger = options.logger ?? createLogger("github.client");
  const maxWaitSeconds = options.maxWaitSeconds ?? MAX_RATE_LIMIT_WAIT_SECONDS;
  const maxRetries = options.maxRetries ?? MAX_RATE_LIMIT_RETRIES;
  const installationId = options.installationId === null ? null : options.installationId.toString();

  const decide = (kind: "primary" | "secondary", retryAfter: number, endpoint: string, retryCount: number): boolean => {
    const willRetry = retryAfter <= maxWaitSeconds && retryCount < maxRetries;
    logger.warn("github rate limit hit", {
      installationId,
      endpoint,
      kind,
      retryAfterSeconds: retryAfter,
      retryCount,
      willRetry,
      maxWaitSeconds,
    });
    return willRetry;
  };

  return {
    onRateLimit(retryAfter: number, requestOptions: Required<EndpointDefaults>, _octokit: Octokit, retryCount: number) {
      // A rate limit is explicitly NOT revocation — §12 requires the two stay
      // distinguishable, and this path never marks a repository ACCESS_LOST.
      return decide("primary", retryAfter, endpointOf(requestOptions), retryCount);
    },

    onSecondaryRateLimit(
      retryAfter: number,
      requestOptions: Required<EndpointDefaults>,
      _octokit: Octokit,
      retryCount: number,
    ) {
      // Secondary ("abuse") limits mean we are being too aggressive rather than out of
      // budget. Same ceiling applies: honor GitHub's stated wait, up to a point.
      return decide("secondary", retryAfter, endpointOf(requestOptions), retryCount);
    },
  };
}
