/** One of four same-named top-level `render` exports — see `src/api/handler.ts`. */
export function render(body: string): string {
  return `<button>${body}</button>`;
}

/** Same-file call (rule 1) to `render` above — this one is unambiguous
 * despite the collision, because it names its own file's declaration
 * directly rather than calling bare `render()` the way `src/api/handler.ts`
 * deliberately does. */
export function renderTwice(body: string): string {
  const once = render(body);
  return once + render(body);
}
