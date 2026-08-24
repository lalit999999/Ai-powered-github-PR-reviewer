import { defineConfig } from "vitest/config";

// Fast, no-I/O unit tests colocated with source (*.test.ts) — same shape as
// apps/api/vitest.config.ts, which is where these tests lived before Phase 03 promoted
// the GitHub client to this package (docs/decisions/phase-03-log.md).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
