import { detectIsTest } from "../filter/file-classifier.js";
import type { ParsedFile } from "../parsing/parsed-file.types.js";

/**
 * Prompt 3, sub-task 3.3: `plan.md` §10.4's third signal — importing a known test
 * framework — layered on top of phase-03's already-shipped path-based
 * {@link detectIsTest}. This module cannot live in `file-classifier.ts` itself: that
 * module is deliberately path-only (no parsing, no `ParsedFile`, per its own header
 * comment), and the framework-import signal needs the parsed import list, which does not
 * exist until Phase 04 parses the file.
 *
 * **Reconciliation with `RepositoryFile.isTest`**: yes, import-based detection should
 * upgrade it, and prompt 4's graph-builder should write `isTest = pathBased ||
 * frameworkImport` rather than leaving phase-03's path-only value untouched. The
 * asymmetry is the same one `file-classifier.ts`'s own header documents for
 * `detectIsTest` (§22): a false positive here costs a slightly-wrong flag on one row; a
 * false negative — a real test file whose name doesn't match any convention, e.g. a
 * suite named `login.spec-helpers.ts` that nonetheless imports `vitest` directly — costs
 * Phase 08 an invisible coverage signal for the exact file the `TESTS` edge exists to
 * surface. Widening, never narrowing, is the only direction that can go wrong safely.
 */

export type TestDetectionSignal = "PATH_CONVENTION" | "FRAMEWORK_IMPORT" | null;

export interface TestDetectionResult {
  isTest: boolean;
  /** Which signal fired — `PATH_CONVENTION` when both fire (checked first, since it is
   * the cheaper, more specific signal and matches phase-03's existing precedent); `null`
   * when neither does. Exposed for debugging a repository with an unusual convention
   * (§0's own framing: "useful for debugging"), not consumed by any other module here. */
  signal: TestDetectionSignal;
}

/**
 * Exact package names matched as a set (`vitest`, `jest`, `mocha`, `playwright`), plus
 * `@testing-library/*` matched by **prefix** (`startsWith`, not a wildcard regex — §0
 * rule 4's own instruction: "where a plain string operation will do, use it instead of a
 * regex"). `@playwright/test` is `playwright`'s own actual npm package name for the test
 * runner (bare `playwright` is the library, `@playwright/test` the test framework most
 * repositories actually import) — both are listed so neither the library-only nor the
 * test-runner-only import shape is missed.
 */
const EXACT_TEST_FRAMEWORK_PACKAGES = new Set(["vitest", "jest", "mocha", "playwright", "@playwright/test", "ts-jest"]);
const TEST_FRAMEWORK_PREFIX = "@testing-library/";

function isTestFrameworkSpecifier(specifier: string): boolean {
  return EXACT_TEST_FRAMEWORK_PACKAGES.has(specifier) || specifier.startsWith(TEST_FRAMEWORK_PREFIX);
}

/**
 * `relativePath` drives the path-based half (identical to phase-03's own
 * {@link detectIsTest}); `parsedFile.imports` drives the framework-import half. A file
 * that merely mentions "test" in its path without matching any of `detectIsTest`'s own
 * conventions (`src/testing-utils.ts` — no `__tests__`/`test`/`tests`/`spec` path
 * segment, no `.test.`/`.spec.` filename marker) and imports nothing test-framework-
 * shaped is correctly `isTest: false` — this function adds a signal, it does not loosen
 * `detectIsTest`'s own already-tested conventions.
 */
export function detectTestFile(relativePath: string, parsedFile: Pick<ParsedFile, "imports">): TestDetectionResult {
  if (detectIsTest(relativePath)) {
    return { isTest: true, signal: "PATH_CONVENTION" };
  }

  const frameworkImport = parsedFile.imports.some((imp) => isTestFrameworkSpecifier(imp.specifier));
  if (frameworkImport) {
    return { isTest: true, signal: "FRAMEWORK_IMPORT" };
  }

  return { isTest: false, signal: null };
}
