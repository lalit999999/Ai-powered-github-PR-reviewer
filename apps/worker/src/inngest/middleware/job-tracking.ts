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
 *
 * ## Phase 06: an inbound `traceId` now wins, deliberately
 *
 * Every event before Phase 06 was fired from *inside* this worker's own process
 * (or had no meaningful upstream trace at all), so "preserve whatever `traceId`
 * `LoggingMiddleware` already generated" was correct by default — there was nothing
 * better to prefer. `pull-request/review.requested` (phase-06 §20) is the first event
 * whose payload already carries a `traceId` minted *upstream*, by `apps/api`'s own
 * request wrapper, before this event ever existed — the concrete proof point for the
 * observability envelope Phase 00 built, per that phase document. Ignoring it and
 * keeping `LoggingMiddleware`'s freshly-generated value would leave every worker log
 * line for a webhook-triggered run uncorrelated with the API request that produced it.
 *
 * The fix lives here, in `mergeEventIds`, not in `LoggingMiddleware`, for two reasons:
 * this middleware already reads `ctx.event.data` and already merges onto the existing
 * context in both hooks, so preferring one more field is the one-line extension this
 * function's entire job already is; `LoggingMiddleware`, by contrast, generates its
 * `traceId` in a field initializer, before it has ever seen an event, so making *it*
 * prefer an inbound value would mean restructuring a class that currently has no access
 * to the data at the point it needs it, for a change that belongs one layer up regardless.
 *
 * The override is safe rather than a race precisely because of the registration order
 * `client.ts`'s own comment documents as deliberate: `LoggingMiddleware` runs first and
 * always establishes a fallback value in the trace context before this middleware ever
 * runs, so this middleware overwriting `merged.traceId` afterward, when an inbound value
 * is present, is a clean, ordered override — not two writers racing for the same field.
 */
export class JobTrackingMiddleware extends Middleware.BaseMiddleware {
  readonly id = "job-tracking";

  override async wrapFunctionHandler({ ctx, next }: Middleware.WrapFunctionHandlerArgs): Promise<unknown> {
    return runWithTraceContext(mergeEventIds(ctx.event?.data), () => next());
  }

  override async wrapStepHandler({ ctx, next }: Middleware.WrapStepHandlerArgs): Promise<unknown> {
    return runWithTraceContext(mergeEventIds(ctx.event?.data), () => next());
  }
}

function mergeEventIds(eventData: unknown): { traceId: string; [key: string]: unknown } {
  const existing = getTraceContext();
  const merged: { traceId: string; [key: string]: unknown } = {
    ...existing,
    // A defensive fallback — in practice LoggingMiddleware (registered first on the
    // client) has always already established a real one by the time this runs.
    traceId: existing?.traceId ?? "no-trace-context",
  };

  const data = eventData as Record<string, unknown> | undefined;
  if (typeof data?.repositoryId === "string") merged.repositoryId = data.repositoryId;
  if (typeof data?.projectId === "string") merged.projectId = data.projectId;

  // Phase 06 §20 — must come AFTER the fallback assignment above, not before: this is
  // an override of that default, not an alternative to it. An empty string or a
  // non-string value (a hand-crafted test event, or a future event type that reuses
  // this field name for something else) falls through to the fallback rather than
  // poisoning the trace context with a value that isn't actually a usable id. See this
  // class's own header comment for why the override is safe here and not in
  // LoggingMiddleware.
  if (typeof data?.traceId === "string" && data.traceId.length > 0) {
    merged.traceId = data.traceId;
  }

  return merged;
}
