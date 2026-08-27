import { getTraceContext, runWithTraceContext } from "@repo/observability";
import { describe, expect, it, vi } from "vitest";
import { JobTrackingMiddleware } from "./job-tracking.js";

function ctxWithEventData(data: unknown): { event: { data: unknown } } {
  return { event: { data } };
}

describe("JobTrackingMiddleware", () => {
  it("wrapFunctionHandler merges repositoryId/projectId from the event onto the trace context", async () => {
    const middleware = new JobTrackingMiddleware({ client: {} as never });
    let observed: unknown;

    await runWithTraceContext({ traceId: "trace-1" }, async () => {
      await middleware.wrapFunctionHandler({
        ctx: ctxWithEventData({
          repositoryId: "repo-1",
          projectId: "proj-1",
        }) as never,
        fn: {} as never,
        next: async () => {
          observed = getTraceContext();
        },
      });
    });

    expect(observed).toMatchObject({
      traceId: "trace-1",
      repositoryId: "repo-1",
      projectId: "proj-1",
    });
  });

  it("wrapStepHandler re-derives the same fields independently (the dual-hook requirement)", async () => {
    const middleware = new JobTrackingMiddleware({ client: {} as never });
    let observed: unknown;

    await runWithTraceContext({ traceId: "trace-2" }, async () => {
      await middleware.wrapStepHandler({
        ctx: ctxWithEventData({
          repositoryId: "repo-2",
          projectId: "proj-2",
        }) as never,
        fn: {} as never,
        next: async () => {
          observed = getTraceContext();
        },
        stepInfo: {} as never,
      });
    });

    expect(observed).toMatchObject({
      traceId: "trace-2",
      repositoryId: "repo-2",
      projectId: "proj-2",
    });
  });

  it("preserves an already-established traceId rather than generating a second one", async () => {
    const middleware = new JobTrackingMiddleware({ client: {} as never });
    let observedTraceId: unknown;

    await runWithTraceContext({ traceId: "established-trace-id" }, async () => {
      await middleware.wrapFunctionHandler({
        ctx: ctxWithEventData({ repositoryId: "repo-3" }) as never,
        fn: {} as never,
        next: async () => {
          observedTraceId = getTraceContext()?.traceId;
        },
      });
    });

    expect(observedTraceId).toBe("established-trace-id");
  });

  it("is a defensive no-op for an event with no repositoryId/projectId — does not crash or set garbage fields", async () => {
    const middleware = new JobTrackingMiddleware({ client: {} as never });
    let observed: unknown;
    const next = vi.fn(async () => {
      observed = getTraceContext();
    });

    await runWithTraceContext({ traceId: "trace-4" }, async () => {
      await middleware.wrapFunctionHandler({
        ctx: ctxWithEventData({}) as never,
        fn: {} as never,
        next,
      });
    });

    expect(next).toHaveBeenCalledOnce();
    expect(observed).toMatchObject({ traceId: "trace-4" });
    expect((observed as Record<string, unknown>).repositoryId).toBeUndefined();
  });

  it("outside any pre-existing trace context, still runs next() with a fallback traceId rather than throwing", async () => {
    const middleware = new JobTrackingMiddleware({ client: {} as never });
    const next = vi.fn(async () => "ok");

    const result = await middleware.wrapFunctionHandler({
      ctx: ctxWithEventData({ repositoryId: "repo-5" }) as never,
      fn: {} as never,
      next,
    });

    expect(result).toBe("ok");
    expect(next).toHaveBeenCalledOnce();
  });
});
