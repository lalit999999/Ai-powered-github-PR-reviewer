import { describe, expect, it } from "vitest";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthenticatedError,
  ValidationError,
} from "./errors.js";

// GithubAccessRevokedError / GithubRateLimitError moved to @repo/github in Phase 03 —
// their own shape/distinguishability tests moved with them
// (packages/github/src/errors.test.ts). See docs/decisions/phase-03-log.md.
const cases = [
  { ErrorClass: ValidationError, httpStatus: 400, code: "VALIDATION_ERROR" },
  { ErrorClass: UnauthenticatedError, httpStatus: 401, code: "UNAUTHENTICATED" },
  { ErrorClass: ForbiddenError, httpStatus: 403, code: "FORBIDDEN" },
  { ErrorClass: NotFoundError, httpStatus: 404, code: "NOT_FOUND" },
  { ErrorClass: ConflictError, httpStatus: 409, code: "CONFLICT" },
  { ErrorClass: ServiceUnavailableError, httpStatus: 503, code: "SERVICE_UNAVAILABLE" },
  { ErrorClass: InternalError, httpStatus: 500, code: "INTERNAL_ERROR" },
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
