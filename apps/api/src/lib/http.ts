import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Logger as PinoLogger } from "pino";
import { AppError, InternalError } from "./errors.js";
import { createLogger } from "./logger.js";
import { generateTraceId, runWithTraceContext } from "./tracing.js";

/**
 * Express equivalent of the phase-00 `withApiRoute` wrapper (see docs/decisions/phase-00-log.md
 * §7 for why this is split into two pieces instead of one function — Express has no
 * per-handler wrapping point equivalent to a Next.js Route Handler export).
 *
 * Mounted once, first, in app.ts. Establishes the trace context for the whole
 * request/response lifecycle and emits exactly one structured "request completed" /
 * "request failed" log line per request (FR2), seeded from an inbound
 * x-trace-id/x-request-id header when present.
 *
 * `pinoInstance` is an injection seam (mirrors createLogger's own) so tests can assert on
 * the real emitted line instead of racing pino's stdout internals.
 */
export function createRequestContext(pinoInstance?: PinoLogger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const inboundTraceId = req.header("x-trace-id") || req.header("x-request-id") || undefined;
    const traceId = inboundTraceId && inboundTraceId.length > 0 ? inboundTraceId : generateTraceId();
    const startedAt = performance.now();

    runWithTraceContext({ traceId }, () => {
      res.setHeader("x-trace-id", traceId);

      res.once("finish", () => {
        const durationMs = Math.round(performance.now() - startedAt);
        const failed = res.statusCode >= 400;
        const component = (res.locals.component as string | undefined) ?? "http";
        const errorCode = res.locals.errorCode as string | undefined;
        const errorStack = res.locals.errorStack as string | undefined;
        const logger = pinoInstance ? createLogger(component, pinoInstance) : createLogger(component);

        logger[failed ? "error" : "info"](failed ? "request failed" : "request completed", {
          method: req.method,
          path: req.originalUrl,
          statusCode: res.statusCode,
          durationMs,
          ...(errorCode ? { code: errorCode } : {}),
          ...(errorStack ? { stack: errorStack } : {}),
        });
      });

      next();
    });
  };
}

export const requestContext = createRequestContext();

type RouteHandler = (req: Request, res: Response, next: NextFunction) => unknown;

/**
 * Wraps a single route handler: declares its `component` (for the completion log line
 * above) and forwards thrown/rejected errors to the error-handling middleware instead of
 * crashing the process (Express does not auto-catch async handler errors).
 */
export function withRoute(handler: RouteHandler, options: { component: string }): RequestHandler {
  return (req, res, next) => {
    res.locals.component = options.component;
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Top-level error boundary (FR3). Mounted last, after every route and the 404 handler.
 * AppError subclasses serialize to their declared status + the standard envelope; any
 * other throw becomes a generic INTERNAL_ERROR 500 with its stack attached to res.locals
 * only for the single completion log line in requestContext above — never in the response
 * body (phase-00 §12).
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const isAppError = err instanceof AppError;
  const appError = isAppError ? err : new InternalError("Internal server error");

  res.locals.errorCode = appError.code;
  if (!isAppError) {
    res.locals.errorStack = err instanceof Error ? err.stack : String(err);
  }

  res.status(appError.httpStatus).json(appError.toEnvelope());
}
