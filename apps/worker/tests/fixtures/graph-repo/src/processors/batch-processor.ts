/** One of three same-named top-level `process` exports — see
 * `../api/dispatcher.ts`. */
export function process(item: string): string {
  return `batch:${item}`;
}

/** Same-file call (rule 1) to `process` above. */
export function processBatch(items: readonly string[]): string[] {
  return items.map((item) => process(item));
}

/** Built-in-only call (`.filter`) — no repo symbol named `filter` exists. */
export function nonEmpty(items: readonly string[]): string[] {
  return items.filter((item) => item.length > 0);
}
