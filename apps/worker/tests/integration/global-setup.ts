import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * A worker-owned Testcontainers Postgres, mirroring `apps/api/tests/integration/global-setup.ts`
 * exactly — see docs/decisions/phase-03-log.md for why the worker gets its **own**
 * container rather than sharing `apps/api`'s harness: the two deployables' integration
 * suites should be runnable (and, in CI, cacheable/parallelizable by Turborepo)
 * independently, without one importing test infrastructure from the other's `tests/`
 * tree, which is not a workspace package and has no `exports` for another app to reach
 * into. The extra ~10–20s container startup this costs is the accepted price of keeping
 * "the worker is a separate deployable" true for its test suite too, not just its
 * runtime.
 */
const DB_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/db");

let container: StartedPostgreSqlContainer | undefined;

export default async function setup(): Promise<() => Promise<void>> {
  container = await new PostgreSqlContainer("postgres:15").withStartupTimeout(120_000).start();

  const databaseUrl = container.getConnectionUri();
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
