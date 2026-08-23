import pino, { type Logger as PinoLogger } from "pino";
import { getTraceContext } from "./tracing.js";

/**
 * Mirrors apps/api/src/lib/logger.ts exactly, including the unconditional redaction
 * list (phase-00 §13 applies to every deployable, not just apps/api) — see
 * docs/decisions/phase-01-log.md for why this is duplicated rather than shared.
 */
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
    base: null,
    timestamp: false,
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

export function createLogger(component: string, instance: PinoLogger = defaultInstance): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    const record = redact({
      ts: new Date().toISOString(),
      ...getTraceContext(),
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
