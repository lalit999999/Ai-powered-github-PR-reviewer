/**
 * Bare `handler(payload)` call with **no import at all** — two same-named
 * `handler` exports exist within `@fixture/core` (`http/handler.ts` and
 * `webhooks/handler.ts`), so this is a genuine N=2 ambiguity: rule 3/4
 * (repo-wide-per-package match, narrowed) applies, producing two
 * AMBIGUOUS_TIEBREAK edges at confidence 0.4/2 = 0.2 each, not a guess at a
 * single "right" one.
 */
export function dispatch(payload: string): string {
  return handler(payload);
}

/** Same-file call (rule 1) to `dispatch` above — a clean positive case
 * sitting right next to the file's own deliberate ambiguity. */
export function dispatchAll(payloads: readonly string[]): string[] {
  return payloads.map((payload) => dispatch(payload));
}
