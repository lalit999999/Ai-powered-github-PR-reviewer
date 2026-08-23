import "dotenv/config";
import { ConfigError, loadConfig, type Config } from "../lib/config.js";
import { createLogger } from "../lib/logger.js";

// The only place src/lib/config.ts's pure loadConfig() runs against the real
// process.env as a module-load side effect — fails fast at boot (FR4), naming every
// missing/invalid variable. Kept at this path (not src/lib/config.ts) so the process
// actually exits on import; lib/config.ts stays side-effect-free and unit-testable.
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
