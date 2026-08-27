import { formatDate } from "@fixture/utils/src/formatters/date-formatter";

/** A top-level (no closer package than the repo root) file calling into a
 * workspace package via a deep subpath import — a clean rule-2 case,
 * exercised from outside any package boundary. */
export function summarize(epochMs: number, label: string): string {
  return `${label}: ${formatDate(epochMs)}`;
}

/** Same-file call (rule 1) to `summarize` above. */
export function summarizeAll(entries: readonly { epochMs: number; label: string }[]): string[] {
  return entries.map((entry) => summarize(entry.epochMs, entry.label));
}
