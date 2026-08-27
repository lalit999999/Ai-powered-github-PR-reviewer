import "dotenv/config";
import { initGithubClient } from "@repo/github";
import { createLogger } from "@repo/observability";
import { ConfigError, loadConfig, type Config } from "../lib/config.js";

// The only place src/lib/config.ts's pure loadConfig() runs against the real
// process.env as a module-load side effect — fails fast at boot (FR4), naming every
// missing/invalid variable. Kept at this path (not src/lib/config.ts) so the process
// actually exits on import; lib/config.ts stays side-effect-free and unit-testable.
function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    const logger = createLogger("config");
    logger.error(
      err instanceof ConfigError
        ? err.message
        : "Invalid environment configuration",
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return process.exit(1);
  }
}

export const env = loadConfigOrExit();

// @repo/github never reads process.env itself (sub-task 1.1) — this is the one boot-time
// call that hands it apps/api's own already-validated values. Must run after env is
// resolved above and before anything imports the GitHub client's default (non-injected)
// code paths, which in practice means "right here, at the top of the module graph".
initGithubClient({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_APP_PRIVATE_KEY,
  redisUrl: env.REDIS_URL,
});
