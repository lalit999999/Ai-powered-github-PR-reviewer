import { z } from "zod";

/**
 * @repo/github's configuration surface. Promoted out of apps/api/src/lib/config.ts in
 * Phase 03 (sub-task 1.1) when the GitHub client became a shared package consumed by
 * both apps/api and apps/worker.
 *
 * **This module never reads `process.env`.** Each consuming app validates its own env
 * with its own Zod schema (they differ — apps/api has dozens of unrelated variables,
 * apps/worker has few) and calls {@link initGithubClient} once at boot with the already-
 * validated values. That keeps the fail-fast-at-boot property (phase-00 §19/FR4) in each
 * app's own hands, exactly as it was before this package existed — a package that dialed
 * `process.env` itself at import time would boot successfully in an app whose *own*
 * config never actually named these variables as required.
 */

const PEM_HEADER = /-----BEGIN (RSA )?PRIVATE KEY-----/;
const PEM_FOOTER = /-----END (RSA )?PRIVATE KEY-----/;

const MALFORMED_KEY_MESSAGE =
  "GITHUB_APP_PRIVATE_KEY is malformed — expected a base64-encoded PKCS#1/PKCS#8 PEM " +
  "(base64 of the whole .pem file GitHub gave you), or the raw PEM itself. " +
  "See docs/github-app-setup.md.";

/**
 * A GitHub App private key is a multi-line PEM, and most .env loaders and hosting
 * providers mangle real newlines. The canonical encoding for this variable is therefore
 * **base64 of the entire .pem file** — one token, no escaping rules, survives every env
 * loader and secret store unchanged.
 *
 * A value that already looks like a PEM is passed through unchanged: dotenv supports
 * multi-line double-quoted values, so pasting the file directly works locally, and
 * silently rejecting it would be a hostile local-dev experience. That is a convenience,
 * not a second supported encoding — deployments use base64. See
 * docs/decisions/phase-02-log.md.
 *
 * Exported so every consuming app's own env schema uses this exact transform rather than
 * re-deriving it — phase-02-log's own note on why this one is non-trivial enough to be
 * worth sharing rather than duplicating a third time (docs/decisions/phase-03-log.md).
 */
export const githubAppPrivateKeySchema = z
  .string()
  .min(1, "GITHUB_APP_PRIVATE_KEY is required")
  // Buffer.from(_, "base64") never throws — it drops non-base64 characters — so garbage
  // decodes to garbage and is caught by the PEM shape check below, not by a try/catch.
  .transform((raw) => {
    const value = raw.trim();
    return PEM_HEADER.test(value) ? value : Buffer.from(value, "base64").toString("utf8");
  })
  .refine((pem) => PEM_HEADER.test(pem) && PEM_FOOTER.test(pem), MALFORMED_KEY_MESSAGE);

/** Same scheme pin as the original apps/api schema: `new URL("localhost:6379")` parses
 * happily (scheme "localhost:"), so a bare `z.url()` would let the single most likely
 * typo sail through to a connect-time failure instead of a boot-time one. */
export const githubRedisUrlSchema = z
  .string()
  .url("REDIS_URL must be a URL, e.g. redis://localhost:6379")
  .refine(
    (value) => /^(rediss?|unix):\/\//.test(value),
    "REDIS_URL must start with redis://, rediss://, or unix:// — e.g. redis://localhost:6379",
  );

export interface GithubClientConfig {
  appId: string;
  /** Already decoded and shape-checked — parse the raw env value with
   * {@link githubAppPrivateKeySchema} before passing it here. */
  privateKey: string;
  redisUrl: string;
}

let resolvedConfig: GithubClientConfig | undefined;

/**
 * Called once, at boot, by each consuming app — `apps/api/src/config/env.ts` and
 * `apps/worker/src/config/env.ts` — immediately after that app's own `loadConfig()`
 * succeeds. Never call this from a test; inject fakes through the existing per-function
 * options instead (every GitHub-client constructor already takes an override for
 * exactly this reason).
 */
export function initGithubClient(config: GithubClientConfig): void {
  resolvedConfig = config;
}

/** Test-only escape hatch back to the uninitialized state. */
export function resetGithubClientConfigForTesting(): void {
  resolvedConfig = undefined;
}

/**
 * Read by the two call sites that need real credentials when no test seam overrides
 * them: app-auth.ts's default JWT factory, and redis.ts's default client. Throws rather
 * than silently reading `undefined` — a package used before its consuming app finished
 * booting is a programming error, not a runtime condition to degrade gracefully from.
 */
export function getGithubClientConfig(): GithubClientConfig {
  if (!resolvedConfig) {
    throw new Error(
      "@repo/github was used before initGithubClient() was called. Call it once at boot, " +
        "after loading and validating your app's own environment.",
    );
  }
  return resolvedConfig;
}
