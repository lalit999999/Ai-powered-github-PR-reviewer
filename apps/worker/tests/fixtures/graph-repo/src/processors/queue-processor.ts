/** One of three same-named top-level `process` exports — the N=3 ambiguity
 * boundary case (allowed, not skipped) — see `../api/dispatcher.ts`. */
export function process(item: string): string {
  return `queue:${item}`;
}

/** Same-file call (rule 1) to `process` above — unambiguous, unlike
 * `dispatcher.ts`'s bare call to the same collision name. */
export function processMany(items: readonly string[]): string[] {
  return items.map((item) => process(item));
}
