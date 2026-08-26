import { describe, expect, it } from "vitest";
import { detectTestFile } from "./test-detection.js";
import type { ParsedImport } from "../parsing/parsed-file.types.js";

function imp(specifier: string): ParsedImport {
  return { specifier, named: [], line: 1, isTypeOnly: false, syntax: "static" };
}

describe("detectTestFile", () => {
  it("detects a *.test.ts filename via the path-convention signal", () => {
    const result = detectTestFile("src/auth/login.test.ts", { imports: [] });
    expect(result).toEqual({ isTest: true, signal: "PATH_CONVENTION" });
  });

  it("detects a __tests__ directory via the path-convention signal", () => {
    const result = detectTestFile("src/auth/__tests__/login.ts", { imports: [] });
    expect(result).toEqual({ isTest: true, signal: "PATH_CONVENTION" });
  });

  it("detects a file with no test-like path that imports vitest", () => {
    const result = detectTestFile("src/auth/login-suite.ts", { imports: [imp("vitest")] });
    expect(result).toEqual({ isTest: true, signal: "FRAMEWORK_IMPORT" });
  });

  it("detects a file that imports jest", () => {
    const result = detectTestFile("src/auth/login-suite.ts", { imports: [imp("jest")] });
    expect(result).toEqual({ isTest: true, signal: "FRAMEWORK_IMPORT" });
  });

  it("detects a file that imports @testing-library/react by prefix", () => {
    const result = detectTestFile("src/components/Button.spec-helper.ts", { imports: [imp("@testing-library/react")] });
    expect(result).toEqual({ isTest: true, signal: "FRAMEWORK_IMPORT" });
  });

  it("detects a file that imports playwright", () => {
    const result = detectTestFile("e2e-helpers/setup.ts", { imports: [imp("@playwright/test")] });
    expect(result).toEqual({ isTest: true, signal: "FRAMEWORK_IMPORT" });
  });

  it("does NOT misclassify a file that merely mentions 'test' in its path with no real signal", () => {
    const result = detectTestFile("src/testing-utils.ts", { imports: [imp("./helpers.js")] });
    expect(result).toEqual({ isTest: false, signal: null });
  });

  it("path-convention wins when both signals fire, per the documented precedence", () => {
    const result = detectTestFile("src/auth/login.test.ts", { imports: [imp("vitest")] });
    expect(result.signal).toBe("PATH_CONVENTION");
  });

  it("is not a test file when neither signal fires", () => {
    const result = detectTestFile("src/auth/login.ts", { imports: [imp("./session.js")] });
    expect(result).toEqual({ isTest: false, signal: null });
  });

  it("does not false-positive on an unrelated package whose name merely contains a framework name as a substring", () => {
    const result = detectTestFile("src/lib.ts", { imports: [imp("jest-worker-pool-utils")] });
    expect(result).toEqual({ isTest: false, signal: null });
  });
});
