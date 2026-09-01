import { describe, expect, it } from "vitest";
import {
  buildPriorityContext,
  computePriorityScore,
  SECURITY_SENSITIVE_PATH,
  touchesSecuritySensitivePath,
  type PriorityContext,
  type PriorityInput,
} from "./priority-score.js";

function baseInput(overrides: Partial<PriorityInput> = {}): PriorityInput {
  return {
    path: "src/file.ts",
    classification: "TEST", // never SOURCE unless a test overrides it — keeps the 40pt term isolated
    additions: 0,
    deletions: 0,
    inboundEdgeCount: 0,
    exportsPublicApi: false,
    noTestLinked: false,
    ...overrides,
  };
}

const ctx: PriorityContext = { maxInboundEdgeCount: 20, maxChurn: 200 };

describe("computePriorityScore — full stack", () => {
  it("SOURCE + max inbound edges + security path + max churn + exports API + no test -> 100", () => {
    const input = baseInput({
      path: "src/auth/session.ts",
      classification: "SOURCE",
      additions: 150,
      deletions: 50, // churn 200 == ctx.maxChurn
      inboundEdgeCount: 20, // == ctx.maxInboundEdgeCount
      exportsPublicApi: true,
      noTestLinked: true,
    });
    // 40 (SOURCE) + 25 (inbound normalized 20/20=1) + 15 (security path) + 10 (churn
    // normalized 200/200=1) + 5 (exports) + 5 (no test) = 100.
    expect(computePriorityScore(input, ctx)).toBe(100);
  });

  it("a DOCUMENTATION file with zero on every term -> 0", () => {
    const input = baseInput({ classification: "DOCUMENTATION" });
    expect(computePriorityScore(input, ctx)).toBe(0);
  });
});

describe("computePriorityScore — each term in isolation", () => {
  it("SOURCE classification alone contributes 40", () => {
    const input = baseInput({ classification: "SOURCE" });
    expect(computePriorityScore(input, ctx)).toBe(40);
  });

  it("inboundEdgeCount at the PR's max alone contributes 25", () => {
    const input = baseInput({ inboundEdgeCount: ctx.maxInboundEdgeCount });
    expect(computePriorityScore(input, ctx)).toBe(25);
  });

  it("a security-sensitive path alone contributes 15", () => {
    const input = baseInput({ path: "src/auth/login.ts" });
    expect(computePriorityScore(input, ctx)).toBe(15);
  });

  it("churn at the PR's max alone contributes 10", () => {
    const input = baseInput({ additions: 120, deletions: 80 }); // churn 200 == ctx.maxChurn
    expect(computePriorityScore(input, ctx)).toBe(10);
  });

  it("exportsPublicApi alone contributes 5", () => {
    const input = baseInput({ exportsPublicApi: true });
    expect(computePriorityScore(input, ctx)).toBe(5);
  });

  it("noTestLinked alone contributes 5", () => {
    const input = baseInput({ noTestLinked: true });
    expect(computePriorityScore(input, ctx)).toBe(5);
  });
});

describe("computePriorityScore — within-PR normalisation", () => {
  it("two files with inbound counts 10 and 5, maxInboundEdgeCount 10, score the 25pt term as 25 and 13 respectively", () => {
    const context: PriorityContext = { maxInboundEdgeCount: 10, maxChurn: 1 };
    const fileA = baseInput({ inboundEdgeCount: 10 });
    const fileB = baseInput({ inboundEdgeCount: 5 });

    // fileA: 25 * (10/10) = 25 -> rounds to 25.
    expect(computePriorityScore(fileA, context)).toBe(25);
    // fileB: 25 * (5/10) = 12.5 -> Math.round rounds half up -> 13. The formula rounds
    // the summed score once, at the end, not each term individually.
    expect(computePriorityScore(fileB, context)).toBe(13);
  });
});

describe("buildPriorityContext", () => {
  it("returns 1 (never 0) for both maximums on an all-zero file set, so normalization never divides by zero", () => {
    const files: PriorityInput[] = [
      baseInput({ inboundEdgeCount: 0, additions: 0, deletions: 0 }),
      baseInput({ inboundEdgeCount: 0, additions: 0, deletions: 0 }),
    ];
    expect(buildPriorityContext(files)).toEqual({ maxInboundEdgeCount: 1, maxChurn: 1 });
  });

  it("returns the true maximums across a mixed file set", () => {
    const files: PriorityInput[] = [
      baseInput({ inboundEdgeCount: 3, additions: 10, deletions: 0 }),
      baseInput({ inboundEdgeCount: 9, additions: 2, deletions: 3 }),
    ];
    expect(buildPriorityContext(files)).toEqual({ maxInboundEdgeCount: 9, maxChurn: 10 });
  });
});

describe("SECURITY_SENSITIVE_PATH / touchesSecuritySensitivePath", () => {
  it.each([
    "src/auth/x.ts",
    "app/payments/y.ts",
    "lib/rbac-policy.ts",
    "middleware/z.ts",
  ])("matches %s", (path) => {
    expect(SECURITY_SENSITIVE_PATH.test(path)).toBe(true);
    expect(touchesSecuritySensitivePath(path)).toBe(true);
  });

  it.each([
    "src/author/x.ts", // "auth" as a substring of a longer segment, not a whole segment
    "docs/authority.md", // same
  ])("does not match %s", (path) => {
    expect(touchesSecuritySensitivePath(path)).toBe(false);
  });
});
