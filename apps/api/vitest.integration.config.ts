import { defineConfig } from "vitest/config";

// Testcontainers-backed integration tests: one shared Postgres container for the whole
// run (started in tests/integration/global-setup.ts), `prisma migrate deploy` applied
// once, tests run serially against it (phase-00 §22 — container startup gets a generous
// timeout now so this doesn't become flaky in every later phase's integration suite).
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
