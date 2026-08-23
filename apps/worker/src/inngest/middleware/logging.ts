import { Middleware } from "inngest";
import { generateTraceId, runWithTraceContext } from "../../lib/tracing.js";

/**
 * Attaches a traceId to each function run via AsyncLocalStorage, exactly like
 * apps/api's request wrapper does for HTTP requests (phase-00 §20), so every
 * createLogger() call made anywhere inside a function's execution — including deep
 * inside a step handler — carries it automatically, with no manual threading.
 *
 * wrapFunctionHandler is Inngest's own documented hook for exactly this use case
 * ("Use cases: AsyncLocalStorage context" — see
 * node_modules/inngest/components/middleware/middleware.d.ts) and runs once per
 * request, wrapping the whole function handler.
 */
export class LoggingMiddleware extends Middleware.BaseMiddleware {
  readonly id = "logging";

  override async wrapFunctionHandler({ next }: Middleware.WrapFunctionHandlerArgs): Promise<unknown> {
    const traceId = generateTraceId();
    return runWithTraceContext({ traceId }, () => next());
  }
}
