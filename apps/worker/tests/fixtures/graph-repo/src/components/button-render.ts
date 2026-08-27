/** One of four same-named top-level `render` exports — see `src/api/handler.ts`. */
export function render(body: string): string {
  return `<button>${body}</button>`;
}
