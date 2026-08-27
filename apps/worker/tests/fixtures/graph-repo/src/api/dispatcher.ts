/**
 * Bare `process(item)` call with no import — three same-named `process`
 * exports exist repo-wide, all top-level (same `packageName` bucket as this
 * file: the root manifest, "graph-repo-fixture"). N=3 is exactly
 * `CALL_AMBIGUITY_MAX_CANDIDATES`, the boundary the N>3 skip does **not**
 * cross — three AMBIGUOUS_TIEBREAK edges are the expected outcome, at
 * confidence 0.4/3, distinct from `handler.ts`'s N=4 skip case.
 */
export function dispatchItem(item: string): string {
  return process(item);
}
