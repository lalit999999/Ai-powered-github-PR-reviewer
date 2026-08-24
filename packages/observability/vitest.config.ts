import { defineConfig } from "vitest/config";

// Fast, no-I/O unit tests colocated with source (*.test.ts) — same shape as
// apps/api/vitest.config.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
