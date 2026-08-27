import { describe, expect, it } from "vitest";
import {
  generateTraceId,
  getTraceContext,
  getTraceId,
  runWithTraceContext,
  setTraceUserId,
} from "./tracing.js";

describe("tracing", () => {
  it("generates ULIDs (26-char Crockford base32, lexicographically sortable)", () => {
    const a = generateTraceId();
    const b = generateTraceId();
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.length).toBe(26);
    expect(a <= b).toBe(true);
  });

  it("getTraceId/getTraceContext are undefined outside a trace context", () => {
    expect(getTraceId()).toBeUndefined();
    expect(getTraceContext()).toBeUndefined();
  });

  it("scopes the context to the callback, including across awaited async work", async () => {
    await runWithTraceContext({ traceId: "trace-a" }, async () => {
      expect(getTraceId()).toBe("trace-a");
      await Promise.resolve();
      expect(getTraceId()).toBe("trace-a");
    });
    expect(getTraceId()).toBeUndefined();
  });

  it("allows extra fields so userId/projectId can slot in later without changing call sites", () => {
    runWithTraceContext({ traceId: "trace-b", userId: "u1" }, () => {
      expect(getTraceContext()).toMatchObject({
        traceId: "trace-b",
        userId: "u1",
      });
    });
  });

  it("setTraceUserId mutates the current context in place (phase-01 §20)", () => {
    runWithTraceContext({ traceId: "trace-c" }, () => {
      expect(getTraceContext()?.userId).toBeUndefined();
      setTraceUserId("user-123");
      expect(getTraceContext()).toMatchObject({
        traceId: "trace-c",
        userId: "user-123",
      });
    });
  });

  it("setTraceUserId is a no-op outside a trace context", () => {
    expect(() => setTraceUserId("user-123")).not.toThrow();
    expect(getTraceContext()).toBeUndefined();
  });

  it("does not leak context across concurrent independent runs", async () => {
    const results: (string | undefined)[] = [];
    await Promise.all([
      runWithTraceContext({ traceId: "x" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push(getTraceId());
      }),
      runWithTraceContext({ traceId: "y" }, async () => {
        results.push(getTraceId());
      }),
    ]);
    expect(results.sort()).toEqual(["x", "y"]);
  });
});
