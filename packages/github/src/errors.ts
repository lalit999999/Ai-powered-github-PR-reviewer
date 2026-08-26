/**
 * Error classes for @repo/github, promoted out of apps/api/src/lib/errors.ts in Phase 03
 * (docs/decisions/phase-03-log.md, sub-task 1.1) when the GitHub client became a shared
 * workspace package consumed by both apps/api and apps/worker.
 *
 * **Deliberately NOT the same `AppError` base apps/api's lib/errors.ts uses.** That base
 * carries `httpStatus` and `toEnvelope()` — HTTP-response concerns that belong to
 * apps/api specifically, and a package cannot import from an app (that would be the
 * dependency direction Option C of sub-task 1.1 rejected, in miniature). Every consumer
 * of these classes today reaches them through `github-result.ts`'s duck-typed
 * `classifyGithubError` (status/response-shape inspection), never `instanceof AppError`,
 * so dropping that base costs nothing behaviorally — see the decision log for the full
 * argument, including why `ServiceUnavailableError` below intentionally shares a name
 * with an unrelated class in apps/api/src/lib/errors.ts.
 */

export interface GithubClientErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
}

export abstract class GithubClientError extends Error {
  abstract readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, options: GithubClientErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.details = options.details ?? {};
  }
}

/**
 * An installation-token mint came back **401**: the installation was revoked, deleted,
 * or suspended. Never retried — a revoked installation does not become un-revoked by
 * asking again. The `connectionStatus -> ACCESS_LOST` transition keys off exactly this
 * case (phase-02 §11/§12); do not confuse it with GithubRateLimitError below.
 */
export class GithubAccessRevokedError extends GithubClientError {
  readonly code = "GITHUB_ACCESS_REVOKED";
}

/**
 * GitHub answered 403/429 with rate-limit headers on a token mint. Distinct from
 * GithubAccessRevokedError — a busy App is not a revoked one. `details.retryAfterSeconds`
 * carries the wait when GitHub stated one (phase-02 §12/§14; reused unchanged by the
 * tarball-fetcher in Phase 03 — see docs/decisions/phase-03-log.md).
 */
export class GithubRateLimitError extends GithubClientError {
  readonly code = "GITHUB_RATE_LIMITED";
}

/**
 * GitHub is transiently unreachable, or returned a 2xx this client does not understand
 * (a bug or an upstream shape change, not a permission state). Retried up to
 * TOKEN_MINT_MAX_ATTEMPTS by the caller before this is thrown.
 */
export class ServiceUnavailableError extends GithubClientError {
  readonly code = "SERVICE_UNAVAILABLE";
}
