import pino, { type Logger as PinoLogger } from "pino";
import { getTraceId } from "./tracing.js";

// Unconditional redaction — active from this commit, before there is anything to leak
// (phase-00 §13). Matches on key name anywhere in the log payload, arbitrarily nested.
const REDACT_EXACT = new Set(["DATABASE_URL"]);
const REDACT_SUFFIXES = ["_KEY", "_SECRET", "_TOKEN"];
const REDACTED_VALUE = "[REDACTED]";
const MAX_REDACT_DEPTH = 10;

function shouldRedactKey(key: string): boolean {
  return REDACT_EXACT.has(key) || REDACT_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth >= MAX_REDACT_DEPTH || value === null || typeof value !== "object" || value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    output[key] = shouldRedactKey(key) ? REDACTED_VALUE : redact(source[key], depth + 1);
  }
  return output;
}

function buildPinoInstance(): PinoLogger {
  return pino({
    level: process.env.LOG_LEVEL || "info",
    base: null, // no pid/hostname — envelope in phase-00 §20 is exhaustive
    timestamp: false, // we stamp `ts` ourselves so the key name matches the envelope
    messageKey: "msg",
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  });
}

const defaultInstance = buildPinoInstance();

export type LogFields = Record<string, unknown>;
type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/**
 * Every call site declares its subsystem via `component`. `traceId` is never threaded
 * manually — it's read from the AsyncLocalStorage context set up by the request wrapper
 * (src/lib/http.ts), per phase-00 §20.
 *
 * `instance` is injectable (defaults to the shared pino instance) so tests can point a
 * logger at an in-memory stream instead of stdout.
 */
export function createLogger(component: string, instance: PinoLogger = defaultInstance): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    const record = redact({
      ts: new Date().toISOString(),
      traceId: getTraceId(),
      component,
      ...fields,
    }) as LogFields;
    instance[level](record, msg);
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
