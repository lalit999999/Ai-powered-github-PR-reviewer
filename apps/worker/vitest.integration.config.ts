import { defineConfig } from "vitest/config";

// Mirrors apps/api/vitest.integration.config.ts — see
// tests/integration/global-setup.ts's own header comment for why the worker gets its
// own Testcontainers Postgres rather than sharing apps/api's.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/integration/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
