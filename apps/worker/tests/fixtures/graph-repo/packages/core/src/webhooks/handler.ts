/** Second of two same-named `handler` exports within `@fixture/core` — see
 * `../http/handler.ts`. */
export function handler(event: string): string {
  return `webhook:${event}`;
}
