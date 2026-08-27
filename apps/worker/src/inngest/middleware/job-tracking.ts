import { Middleware } from "inngest";
import { getTraceContext, runWithTraceContext } from "@repo/observability";

/**
 * Adds `repositoryId`/`projectId` to the trace context for every log line inside a
 * function triggered by an event that carries them — §20's "`repositoryId`... present on
 * every relevant log line" requirement, without every `createLogger(...).info(...)` call
 * in `repository-index.ts` having to pass them explicitly by hand.
 *
 * ## Both hooks, for the same reason `LoggingMiddleware` wraps both
 *
 * `middleware/logging.ts`'s doc comment records a verified fact: `wrapFunctionHandler`'s
 * AsyncLocalStorage context does not survive into a `step.run()` callback — Inngest's
 * checkpointing machinery re-enters step callbacks through a path that is not a
 * causally-linked continuation of the context `wrapFunctionHandler` established. The
 * same constraint applies here, identically, so both hooks re-derive and re-establish
 * the context rather than relying on one to have already set it up for the other.
 *
 * Unlike `LoggingMiddleware` (which stores a single `traceId` at construction time and
 * reuses it in both hooks), this middleware has nothing to store at construction —
 * `repositoryId`/`projectId` only exist once `ctx.event.data` is available, which is
 * something *both* hooks receive on every call, not something known any earlier. So
 * both hooks independently read `ctx.event.data`, defensively (this middleware is
 * registered client-wide, so it runs for any future function/event shape too, not only
 * `repository-index`'s), and merge onto whatever trace context already exists —
 * preserving `traceId` (and anything else, e.g. a future `userId`) rather than
 * generating a second, different one that would break correlation with
 * `LoggingMiddleware`'s own.
 *
 * **`indexJobId` is deliberately not handled here.** It does not exist at event-fire
 * time — `repository-index.ts`'s own step 1 creates it — so there is no moment before
 * the function body runs when this middleware could know it. `repository-index.ts`'s
 * step bodies include it explicitly in their own log calls instead, once it is known.
 */
export class JobTrackingMiddleware extends Middleware.BaseMiddleware {
  readonly id = "job-tracking";

  override async wrapFunctionHandler({
    ctx,
    next,
  }: Middleware.WrapFunctionHandlerArgs): Promise<unknown> {
    return runWithTraceContext(mergeEventIds(ctx.event?.data), () => next());
  }

  override async wrapStepHandler({
    ctx,
    next,
  }: Middleware.WrapStepHandlerArgs): Promise<unknown> {
    return runWithTraceContext(mergeEventIds(ctx.event?.data), () => next());
  }
}

function mergeEventIds(eventData: unknown): {
  traceId: string;
  [key: string]: unknown;
} {
  const existing = getTraceContext();
  const merged: { traceId: string; [key: string]: unknown } = {
    ...existing,
    // A defensive fallback — in practice LoggingMiddleware (registered first on the
    // client) has always already established a real one by the time this runs.
    traceId: existing?.traceId ?? "no-trace-context",
  };

  const data = eventData as Record<string, unknown> | undefined;
  if (typeof data?.repositoryId === "string")
    merged.repositoryId = data.repositoryId;
  if (typeof data?.projectId === "string") merged.projectId = data.projectId;

  return merged;
}
