/** Second of two same-named `handler` exports within `@fixture/core` — see
 * `../http/handler.ts`. */
export function handler(event: string): string {
  return normalizeEvent(event);
}

/** Same-file call (rule 1), plus a built-in call (`.toLowerCase`). */
function normalizeEvent(event: string): string {
  return `webhook:${event.toLowerCase()}`;
}
