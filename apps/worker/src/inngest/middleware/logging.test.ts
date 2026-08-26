import { beforeEach, describe, expect, it, vi } from "vitest";

const logSpies = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock("@repo/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/observability")>()),
  createLogger: () => logSpies,
}));

const { LoggingMiddleware } = await import("./logging.js");

beforeEach(() => {
  vi.clearAllMocks();
});

/** Matches the real shape enough for this middleware's own fields — `stepInfo`'s other
 * properties are never read here. */
function stepInfo(overrides: { id: string; memoized: boolean; stepType?: string }) {
  return {
    hashedId: "hashed",
    memoized: overrides.memoized,
    options: { id: overrides.id },
    stepType: overrides.stepType ?? "run",
  };
}

describe("LoggingMiddleware.wrapStepHandler — step-duration logging (phase-03 §20)", () => {
  it("logs stepId/stepType/durationMs for a genuinely-executed step", async () => {
    const middleware = new LoggingMiddleware({ client: {} as never });

    const result = await middleware.wrapStepHandler({
      ctx: {} as never,
      fn: {} as never,
      stepInfo: stepInfo({ id: "acquire-lock", memoized: false }) as never,
      next: async () => "step-result",
    });

    expect(result).toBe("step-result");
    expect(logSpies.info).toHaveBeenCalledOnce();
    const [message, fields] = logSpies.info.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe("step completed");
    expect(fields).toMatchObject({ stepId: "acquire-lock", stepType: "run" });
    expect(typeof fields.durationMs).toBe("number");
    expect(fields.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it("does not log a duration for a memoized (replayed) step — it did not actually run", async () => {
    const middleware = new LoggingMiddleware({ client: {} as never });

    const result = await middleware.wrapStepHandler({
      ctx: {} as never,
      fn: {} as never,
      stepInfo: stepInfo({ id: "resolve-target", memoized: true }) as never,
      next: async () => "cached-result",
    });

    expect(result).toBe("cached-result");
    expect(logSpies.info).not.toHaveBeenCalled();
  });

  it("still logs the duration when the step throws — a failing step's timing is not lost", async () => {
    const middleware = new LoggingMiddleware({ client: {} as never });

    await expect(
      middleware.wrapStepHandler({
        ctx: {} as never,
        fn: {} as never,
        stepInfo: stepInfo({ id: "fetch-extract-persist", memoized: false }) as never,
        next: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");

    expect(logSpies.info).toHaveBeenCalledOnce();
    const [, fields] = logSpies.info.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields).toMatchObject({ stepId: "fetch-extract-persist" });
  });
});
