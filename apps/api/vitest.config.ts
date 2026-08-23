import { defineConfig } from "vitest/config";

// Fast, no-I/O unit tests colocated with source (*.test.ts). Integration tests
// (Testcontainers-backed) live in tests/integration and run via vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
