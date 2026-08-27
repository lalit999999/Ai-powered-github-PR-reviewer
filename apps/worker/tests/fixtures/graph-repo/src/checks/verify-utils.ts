import { expect, test } from "vitest";
import { capitalize } from "@utils/string-utils";

/**
 * A test file detectable **only by framework import**, not by path — its
 * path (`src/checks/verify-utils.ts`) matches none of `detectIsTest`'s path
 * conventions (`__tests__`, a `test`/`tests`/`spec` directory segment,
 * `.test.`/`.spec.` in the filename), but it imports `vitest` directly. See
 * `apps/web/tests/user-card.test.tsx` for the path-convention counterpart.
 */
/** A named helper (unlike the `test(...)` callback below, this has a real
 * enclosing symbol) — a clean cross-package rule-2 call to `capitalize`. */
function checkCapitalize(input: string): boolean {
  return capitalize(input).length > 0;
}

test("capitalize works", () => {
  expect(checkCapitalize("ok")).toBe(true);
});
