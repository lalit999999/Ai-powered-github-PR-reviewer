import { Middleware } from "inngest";
import { generateTraceId, runWithTraceContext } from "@repo/observability";

/**
 * Attaches a traceId to each function run via AsyncLocalStorage, exactly like
 * apps/api's request wrapper does for HTTP requests (phase-00 §20), so every
 * createLogger() call made anywhere inside a function's execution carries it
 * automatically, with no manual threading required from function authors.
 *
 * Wraps *two* hooks, not one — verified empirically to be necessary, not assumed:
 * `wrapFunctionHandler`'s AsyncLocalStorage context does not survive into a
 * `step.run()` callback (traced with debug logging — the context is present at the
 * top of the function handler but reads as `undefined` inside the step callback,
 * most likely due to Inngest's checkpointing machinery — `ClientOptions.checkpointing`
 * defaults to `true` — invoking the callback via a path that isn't a causally-linked
 * continuation of the request that entered `wrapFunctionHandler`). Middleware
 * instances are constructed fresh per-request ("so that middleware can safely use
 * `this` for request-scoped state" — node_modules/inngest's own doc comment), so a
 * single traceId generated at construction time is reused by both hooks: function
 * code outside any step gets it from `wrapFunctionHandler`, and step callback bodies
 * get it re-established by `wrapStepHandler`, with the exact same value either way.
 */
export class LoggingMiddleware extends Middleware.BaseMiddleware {
  readonly id = "logging";
  private readonly traceId = generateTraceId();

  override async wrapFunctionHandler({ next }: Middleware.WrapFunctionHandlerArgs): Promise<unknown> {
    return runWithTraceContext({ traceId: this.traceId }, () => next());
  }

  override async wrapStepHandler({ next }: Middleware.WrapStepHandlerArgs): Promise<unknown> {
    return runWithTraceContext({ traceId: this.traceId }, () => next());
  }
}
