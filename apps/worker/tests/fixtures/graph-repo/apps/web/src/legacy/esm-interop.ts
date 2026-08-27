// ESM `.js`-specifier import pointing at a `.ts` file — the common
// TypeScript-with-`"module": "nodenext"` shape, where source files
// reference each other with the `.js` extension they will have once
// compiled, even though only `sibling.ts` exists on disk.
import { siblingValue } from "./sibling.js";

/** Cross-file named import (rule 2) through the `.js`-specifier / `.ts`-file
 * ESM interop resolution step. */
export function legacyEntry(): number {
  return siblingValue() * 2;
}

/** Same-file call (rule 1) to `legacyEntry` above. */
export function legacyEntryDoubled(): number {
  return legacyEntry() * 2;
}
