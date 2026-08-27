/** One of three same-named top-level `process` exports — see
 * `../api/dispatcher.ts`. */
export function process(item: string): string {
  return `stream:${item}`;
}
