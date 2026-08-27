import { capitalize, trim } from "./string-utils";

/** `index` — one of the three collision names phase-04 §22 names explicitly
 * (`handler`, `index`, `render`); this one is benign (never called
 * ambiguously in this fixture, just present for realism). Calls
 * `capitalize` — a clean same-package named import (rule 2). */
export function index(items: readonly string[]): string[] {
  return items.map((item) => capitalize(item));
}

/** A second clean rule-2 case in the same file, this time for `trim`. */
export function normalize(items: readonly string[]): string[] {
  return items.map((item) => trim(item));
}
