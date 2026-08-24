export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

export interface AppErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Typed base for every error a route handler is expected to throw on purpose. Serializes
 * to the standard envelope from plan.md §28. Anything thrown that is *not* an AppError is
 * treated as a bug — src/lib/http.ts converts it to a generic InternalError and logs the
 * original stack, never the raw message, in the response body.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details: Record<string, unknown>;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.details = options.details ?? {};
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}

export class ValidationError extends AppError {
  readonly code = "VALIDATION_ERROR";
  readonly httpStatus = 400;
}

export class UnauthenticatedError extends AppError {
  readonly code = "UNAUTHENTICATED";
  readonly httpStatus = 401;
}

export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN";
  readonly httpStatus = 403;
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  readonly httpStatus = 404;
}

export class ConflictError extends AppError {
  readonly code = "CONFLICT";
  readonly httpStatus = 409;
}

export class ServiceUnavailableError extends AppError {
  readonly code = "SERVICE_UNAVAILABLE";
  readonly httpStatus = 503;
}

/** Distinct from ServiceUnavailableError so /api/health (and any future dependency
 * check) can report the specific cause per phase-00 §7/§12: `{"code": "DB_UNAVAILABLE"}`. */
export class DbUnavailableError extends AppError {
  readonly code = "DB_UNAVAILABLE";
  readonly httpStatus = 503;
}

/**
 * Phase 02 §11/§12. A GitHub App installation token mint came back **401**: the
 * installation was revoked, deleted, or suspended. Deliberately its own class rather
 * than a plain ForbiddenError, because the service layer keys the
 * `connectionStatus → ACCESS_LOST` transition off exactly this case and must not
 * confuse it with "this user may not touch this project" (a tenancy 403) or with
 * "the App is rate limited" (GithubRateLimitError below).
 *
 * Never retried — a revoked installation does not become un-revoked by trying again.
 * The transition itself belongs to the service layer (Prompt 2 of this phase) and is
 * only fully exercised once Phase 03 has background work that can fail.
 */
export class GithubAccessRevokedError extends AppError {
  readonly code = "GITHUB_ACCESS_REVOKED";
  readonly httpStatus = 403;
}

/**
 * Phase 02 §12/§14. GitHub answered 403/429 with rate-limit headers. Distinct from
 * GithubAccessRevokedError above — §14 requires that a rate-limited response is
 * "a scheduled retry, not an immediate failure", and never mistaken for revocation.
 *
 * 503 rather than 429: the exhausted budget is *ours* against GitHub, not the calling
 * user's against this API, so telling the client "you are sending too many requests"
 * would be wrong. `details.retryAfterSeconds` carries the wait when GitHub stated one.
 */
export class GithubRateLimitError extends AppError {
  readonly code = "GITHUB_RATE_LIMITED";
  readonly httpStatus = 503;
}

export class InternalError extends AppError {
  readonly code = "INTERNAL_ERROR";
  readonly httpStatus = 500;
}
