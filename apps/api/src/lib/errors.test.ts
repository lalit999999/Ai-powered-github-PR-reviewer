import { describe, expect, it } from "vitest";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  GithubAccessRevokedError,
  GithubRateLimitError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthenticatedError,
  ValidationError,
} from "./errors.js";

const cases = [
  { ErrorClass: ValidationError, httpStatus: 400, code: "VALIDATION_ERROR" },
  { ErrorClass: UnauthenticatedError, httpStatus: 401, code: "UNAUTHENTICATED" },
  { ErrorClass: ForbiddenError, httpStatus: 403, code: "FORBIDDEN" },
  { ErrorClass: NotFoundError, httpStatus: 404, code: "NOT_FOUND" },
  { ErrorClass: ConflictError, httpStatus: 409, code: "CONFLICT" },
  { ErrorClass: ServiceUnavailableError, httpStatus: 503, code: "SERVICE_UNAVAILABLE" },
  { ErrorClass: InternalError, httpStatus: 500, code: "INTERNAL_ERROR" },
  // Phase 02 §11/§12
  { ErrorClass: GithubAccessRevokedError, httpStatus: 403, code: "GITHUB_ACCESS_REVOKED" },
  { ErrorClass: GithubRateLimitError, httpStatus: 503, code: "GITHUB_RATE_LIMITED" },
] as const;

describe.each(cases)("$code", ({ ErrorClass, httpStatus, code }) => {
  it(`serializes to ${httpStatus} with the standard envelope`, () => {
    const err = new ErrorClass("boom", { details: { field: "x" } });
    expect(err.httpStatus).toBe(httpStatus);
    expect(err.code).toBe(code);
    expect(err.toEnvelope()).toEqual({
      error: { code, message: "boom", details: { field: "x" } },
    });
  });

  it("defaults details to {} when none are given", () => {
    const err = new ErrorClass("boom");
    expect(err.toEnvelope().error.details).toEqual({});
  });

  it("is a real Error and an AppError", () => {
    const err = new ErrorClass("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe(ErrorClass.name);
    expect(typeof err.stack).toBe("string");
  });
});

// The distinction these two carry is the whole reason they are separate classes: the
// service layer maps one to connectionStatus = ACCESS_LOST and must never map the other
// there (phase-02 §11/§12).
describe("GitHub client errors stay distinguishable", () => {
  it("a rate-limit error is not an access-revoked error, and vice versa", () => {
    expect(new GithubRateLimitError("limited")).not.toBeInstanceOf(GithubAccessRevokedError);
    expect(new GithubAccessRevokedError("revoked")).not.toBeInstanceOf(GithubRateLimitError);
  });

  it("neither collapses into the generic ForbiddenError used for tenancy checks", () => {
    expect(new GithubAccessRevokedError("revoked")).not.toBeInstanceOf(ForbiddenError);
    expect(new GithubRateLimitError("limited")).not.toBeInstanceOf(ForbiddenError);
  });
});
