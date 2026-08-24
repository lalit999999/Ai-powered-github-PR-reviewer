import "dotenv/config";
import { ConfigError, loadConfig, type Config } from "../lib/config.js";
import { createLogger } from "@repo/observability";

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
