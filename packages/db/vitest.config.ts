import { defineConfig } from "vitest/config";

// Fast, no-I/O unit tests colocated with source (*.test.ts) — same shape as
// packages/shared/vitest.config.ts and packages/observability/vitest.config.ts. Only
// the hybrid scorer (packages/db/src/vector/hybrid-scorer.ts) is pure enough to unit
// test here; everything else in this package touches Postgres and is exercised by
// apps/worker's/apps/api's own integration suites instead.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
