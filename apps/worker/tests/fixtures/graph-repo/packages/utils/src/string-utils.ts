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

/** Same-file calls (rule 1) to both `capitalize` and `logLine` above. */
export function capitalizeAndLog(value: string): string {
  const result = capitalize(value);
  return logLine(result);
}

/** A repo-wide unique match (rule 3) — `pad` (declared in `./pad.ts`) is
 * called bare, with **no import at all**; it names no other repo symbol
 * within this package's bucket, so it resolves via the name index directly,
 * at 0.7 confidence rather than a named import's 0.9. */
export function padAndCapitalize(value: string, width: number): string {
  return capitalize(pad(value, width));
}
