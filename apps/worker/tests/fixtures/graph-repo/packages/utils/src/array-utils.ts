export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Same-file call (rule 1) — `unique` calls `chunk` only to exercise a
 * same-file cross-function call between two already-exported functions
 * (not a realistic implementation, a fixture convenience). */
export function unique<T>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const batch of chunk(items, items.length || 1)) {
    for (const item of batch) {
      if (!seen.has(item)) {
        seen.add(item);
        result.push(item);
      }
    }
  }
  return result;
}

/** Same-file calls (rule 1) to both `chunk` and `unique` above. */
export function chunkUnique<T>(items: readonly T[], size: number): T[][] {
  return chunk(unique(items), size);
}

/** Built-in-only calls (`Array.prototype.reduce`/`join`) — no repo symbol
 * named `reduce` or `join` exists, so both are correct abstentions. */
export function sum(items: readonly number[]): string {
  return items.reduce((total, item) => total + item, 0).toString();
}

export function joinAll(items: readonly string[][]): string {
  return items.map((batch) => batch.join(",")).join(";");
}
