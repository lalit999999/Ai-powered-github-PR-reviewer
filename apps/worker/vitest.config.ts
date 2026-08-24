import { defineConfig } from "vitest/config";

// Fast, no-I/O unit tests colocated with source (*.test.ts) — same shape as
// apps/api/vitest.config.ts. First used in Phase 03 for the tarball-fetcher and
// archive-extractor security tests; apps/worker had no test infrastructure before this.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Sub-tasks 1.1/1.2/1.3 of this phase land before the fetcher/extractor tests in
    // 1.4-1.6 add the first *.test.ts files here — without this, an empty suite exits
    // 1 and fails every earlier sub-task's verification gate for no real reason.
    // Harmless once real tests exist (matches apps/api's config, which never needed it).
    passWithNoTests: true,
  },
});
