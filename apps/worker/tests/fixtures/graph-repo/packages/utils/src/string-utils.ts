import { LOG_PREFIX } from "@fixture/core/src/config";

/** Same-file call (rule 1, SAME_FILE) — `capitalize` calls `trim`, both
 * declared in this file. */
export function capitalize(value: string): string {
  const trimmed = trim(value);
  if (trimmed.length === 0) return trimmed;
  return trimmed[0]!.toUpperCase() + trimmed.slice(1);
}

export function trim(value: string): string {
  return value.trim();
}

/** Uses LOG_PREFIX purely as a reference (no CodeSymbol exists for it — see
 * config.ts's own comment) — this function's own body is what keeps the
 * import from looking dead, not a call-resolution case. */
export function logLine(message: string): string {
  return `${LOG_PREFIX} ${message}`;
}
