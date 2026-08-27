/** Target of the `@app/shared/*` alias — deliberately at `src/shared-special/*`,
 * not `src/shared/*`, so a resolver that naively strips only the `@app/*`
 * prefix (ignoring the longer, more specific `@app/shared/*` entry) would
 * resolve to a directory that does not exist. `main.ts` imports from here via
 * `@app/shared/constants` to prove the longest-prefix match wins. */
export function appName(): string {
  return "graph-repo-fixture-web";
}
