import "dotenv/config";
import { initGithubClient } from "@repo/github";
import { createLogger } from "@repo/observability";
import { ConfigError, loadConfig, type Config } from "../lib/config.js";

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    const logger = createLogger("config");
    logger.error(err instanceof ConfigError ? err.message : "Invalid environment configuration", {
      error: err instanceof Error ? err.message : String(err),
    });
    return process.exit(1);
  }
}

export const env = loadConfigOrExit();

// See apps/api/src/config/env.ts's identical call — @repo/github never reads
// process.env itself (docs/decisions/phase-03-log.md, sub-task 1.1).
initGithubClient({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY, redisUrl: env.REDIS_URL });
