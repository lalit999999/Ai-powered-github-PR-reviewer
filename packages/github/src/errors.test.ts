import { describe, expect, it } from "vitest";
import {
  GithubAccessRevokedError,
  GithubClientError,
  GithubRateLimitError,
  ServiceUnavailableError,
} from "./errors.js";

// Moved from apps/api/src/lib/errors.test.ts in Phase 03 (sub-task 1.1) along with the
// classes themselves — see docs/decisions/phase-03-log.md. No longer asserts
// `instanceof AppError` or `instanceof ForbiddenError`: those were apps/api-specific
// concepts that stopped applying the moment these classes stopped extending AppError.

const cases = [
  { ErrorClass: GithubAccessRevokedError, code: "GITHUB_ACCESS_REVOKED" },
  { ErrorClass: GithubRateLimitError, code: "GITHUB_RATE_LIMITED" },
  { ErrorClass: ServiceUnavailableError, code: "SERVICE_UNAVAILABLE" },
] as const;

describe.each(cases)("$code", ({ ErrorClass, code }) => {
  it("carries the code and details", () => {
    const err = new ErrorClass("boom", { details: { field: "x" } });
    expect(err.code).toBe(code);
    expect(err.details).toEqual({ field: "x" });
  });

  it("defaults details to {} when none are given", () => {
    const err = new ErrorClass("boom");
    expect(err.details).toEqual({});
  });

  it("is a real Error and a GithubClientError", () => {
    const err = new ErrorClass("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GithubClientError);
    expect(err.name).toBe(ErrorClass.name);
    expect(typeof err.stack).toBe("string");
  });
});

// The distinction these two carry is the whole reason they are separate classes: the
// service layer maps one to connectionStatus = ACCESS_LOST and must never map the other
// there (phase-02 §11/§12).
describe("rate-limit and access-revoked stay distinguishable", () => {
  it("a rate-limit error is not an access-revoked error, and vice versa", () => {
    expect(new GithubRateLimitError("limited")).not.toBeInstanceOf(
      GithubAccessRevokedError,
    );
    expect(new GithubAccessRevokedError("revoked")).not.toBeInstanceOf(
      GithubRateLimitError,
    );
  });
});
