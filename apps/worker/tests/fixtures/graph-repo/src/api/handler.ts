/**
 * Bare `render()` call with no import, from a top-level file (no ancestor
 * `package.json` — `packageName` is `null`). Four same-named `render`
 * exports exist repo-wide, all also top-level (`../components/*-render.ts`),
 * so all five files share the same `""` name-index bucket regardless of
 * per-package partitioning. N=4 exceeds `CALL_AMBIGUITY_MAX_CANDIDATES` (3),
 * so rule 4's skip applies: **no** CALLS edge is the correct outcome here —
 * this is the literal example this phase's spec prompt itself uses.
 */
export function handle(body: string): string {
  return render(body);
}
