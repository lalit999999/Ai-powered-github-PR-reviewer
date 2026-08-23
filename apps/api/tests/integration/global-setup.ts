import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

// packages/db owns prisma/schema.prisma + prisma.config.ts; migrate deploy must run with
// that as cwd. Resolved from this file's own location so it doesn't depend on the shell's
// cwd when `pnpm test:integration` is invoked.
const DB_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/db");

let container: StartedPostgreSqlContainer | undefined;

export default async function setup(): Promise<() => Promise<void>> {
  container = await new PostgreSqlContainer("postgres:15").withStartupTimeout(120_000).start();

  const databaseUrl = container.getConnectionUri();
  // Visible to the test files themselves — Vitest runs globalSetup before loading any
  // test module, and worker processes inherit process.env from this point on.
  process.env.DATABASE_URL = databaseUrl;

  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: DB_PACKAGE_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });

  return async () => {
    await container?.stop();
  };
}
