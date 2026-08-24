import pino, { type Logger as PinoLogger } from "pino";
import { getTraceContext } from "./tracing.js";

// Promoted from apps/api/src/lib/logger.ts in Phase 03 (docs/decisions/phase-03-log.md)
// so apps/api, apps/worker, and @repo/github share one logger — and, more importantly,
// one AsyncLocalStorage-backed trace context (tracing.ts below). Before this move,
// apps/worker carried its own byte-identical-at-the-time copy (phase-01-log §9) that had
// since drifted and was missing the phase-02 §13 redaction rules below; that drift is
// structurally impossible now that there is exactly one copy.
//
// Unconditional redaction — active from this commit, before there is anything to leak
// (phase-00 §13). Matches on key name anywhere in the log payload, arbitrarily nested.
const REDACT_EXACT = new Set(["DATABASE_URL"]);
const REDACT_SUFFIXES = ["_KEY", "_SECRET", "_TOKEN"];

// Phase 02 §13 requires that installation tokens are "never logged". The SCREAMING_CASE
// suffix rules above only ever matched environment-variable names; a camelCase or plain
// field — `token`, `accessToken`, `privateKey` — would have gone straight to stdout.
// These rules match on a normalized key (lowercased, separators stripped), so
// `token` / `access_token` / `accessToken` / `ACCESS-TOKEN` are all one rule.
//
// Deliberately NOT redacted: a bare `key`. The token cache logs its *cache key* by
// design (phase-02 sub-task 1.3 — "log the key, the hit/miss, and the remaining TTL,
// never the token"), and a cache key is not a secret. `apiKey`/`privateKey` are matched
// explicitly instead of by a blanket `*key` suffix.
const REDACT_NORMALIZED_EXACT = new Set(["authorization", "cookie", "setcookie", "credentials", "pem"]);
const REDACT_NORMALIZED_SUFFIXES = ["token", "secret", "password", "passphrase", "privatekey", "apikey"];

const REDACTED_VALUE = "[REDACTED]";
const MAX_REDACT_DEPTH = 10;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function shouldRedactKey(key: string): boolean {
  if (REDACT_EXACT.has(key) || REDACT_SUFFIXES.some((suffix) => key.endsWith(suffix))) {
    return true;
  }
  const normalized = normalizeKey(key);
  return REDACT_NORMALIZED_EXACT.has(normalized) || REDACT_NORMALIZED_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
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
 * Every call site declares its subsystem via `component`. `traceId` — and, once a
 * request has authenticated, `userId` (phase-01 §20) — is never threaded manually:
 * both are read from the same AsyncLocalStorage context set up by the request wrapper
 * (src/lib/http.ts) and extended by src/lib/auth/session.ts, per phase-00 §20's
 * envelope, extended rather than redesigned.
 *
 * `instance` is injectable (defaults to the shared pino instance) so tests can point a
 * logger at an in-memory stream instead of stdout.
 */
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
