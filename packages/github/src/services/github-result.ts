/**
 * The shared failure vocabulary for `src/github/services/**`.
 *
 * Every wrapper in this directory maps GitHub's HTTP responses to a **typed domain
 * result** rather than letting an Octokit error escape. Two reasons, both from the
 * phase document:
 *
 * 1. §12 requires each validation failure to produce its own distinct, actionable
 *    error. A service that has to pattern-match on `err.status` and Octokit's internal
 *    error shape to tell "no access" from "GitHub is down" will get it wrong once and
 *    then stay wrong.
 * 2. Rule A keeps the GitHub client out of routes and controllers, and this is the
 *    boundary where "an HTTP status from github.com" stops and "a domain outcome"
 *    starts.
 */

/**
 * **`NOT_ACCESSIBLE` is deliberately one reason, not two.**
 *
 * phase-02 §12: GitHub returns **404, not 403**, for a repository an installation
 * cannot see. That is an anti-enumeration measure on GitHub's side — it exists
 * precisely so a caller cannot distinguish "this private repository exists and you may
 * not have it" from "there is no such repository". Splitting this into `NOT_FOUND` and
 * `FORBIDDEN` here would mean inventing a distinction the wire does not carry, and the
 * invention would be a guess dressed as a fact.
 *
 * So the wrapper reports what it actually knows, and the *service* decides what to
 * tell the user (phase-02 §12 answers 403 with "the GitHub App doesn't have access to
 * this repository — check your installation settings", which is the actionable answer
 * for both underlying cases).
 */
export type GithubFailureReason =
  /** 404 or 403-without-rate-limit-headers: the repo does not exist, or the
   * installation cannot see it. Indistinguishable by design — see above. */
  | "NOT_ACCESSIBLE"
  /** The installation token could not be minted, or GitHub answered 5xx after the
   * client's own retries. Transient; the caller should say "try again". */
  | "UNAVAILABLE"
  /** The *user's* OAuth token was rejected (401). Only reachable from the one
   * user-authenticated call; means the sign-in needs refreshing, not that the App
   * lost access. */
  | "UNAUTHENTICATED";

export type GithubResult<T> = ({ ok: true } & T) | { ok: false; reason: GithubFailureReason };

/** Narrow an unknown thrown value to the status Octokit puts on its errors, without
 * importing an error class — the same duck-typing discipline `project.repository.ts`
 * uses for Prisma's `P2002`. */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/** True when GitHub's response carried rate-limit headers, which is how §12 keeps a
 * 403-because-busy from being read as a 403-because-revoked. */
export function hasRateLimitHeaders(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("response" in error)) return false;
  const headers = (error as { response?: { headers?: Record<string, unknown> } }).response?.headers;
  return Boolean(headers && ("x-ratelimit-remaining" in headers || "retry-after" in headers));
}

/**
 * The single place an Octokit throw becomes a `GithubFailureReason`.
 *
 * `404` and `403`-without-rate-limit-headers both collapse to `NOT_ACCESSIBLE` for the
 * reason above. `401` is `UNAUTHENTICATED` — reachable only on the user-OAuth path,
 * since a *revoked installation* is caught earlier by app-auth and thrown as
 * `GithubAccessRevokedError` before a request is ever made. Everything else, including
 * a 403 that came with rate-limit headers, is `UNAVAILABLE`: transient from the
 * caller's point of view, and never a reason to mark a repository `ACCESS_LOST`.
 */
export function classifyGithubError(error: unknown): GithubFailureReason {
  const status = statusOf(error);
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 404) return "NOT_ACCESSIBLE";
  if (status === 403 && !hasRateLimitHeaders(error)) return "NOT_ACCESSIBLE";
  return "UNAVAILABLE";
}
