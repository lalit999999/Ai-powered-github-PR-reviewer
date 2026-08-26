import { githubAppPrivateKeySchema, githubRedisUrlSchema } from "@repo/github";
import { z } from "zod";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const GIB = 1024 ** 3;

/**
 * Mirrors apps/api/src/lib/config.ts's pattern (pure, side-effect-free; the fail-fast
 * process.exit lives in src/config/env.ts) — see docs/decisions/phase-01-log.md for
 * why apps/worker doesn't share apps/api's config module directly (the two schemas
 * genuinely differ — apps/api has dozens of variables the worker will never need, like
 * the OAuth/session secrets). The GitHub App private-key transform and the REDIS_URL
 * scheme check ARE shared, via @repo/github, rather than re-derived a second time —
 * see docs/decisions/phase-03-log.md, sub-task 1.1/1.2.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  INNGEST_EVENT_KEY: z.string().min(1, "INNGEST_EVENT_KEY is required"),
  INNGEST_SIGNING_KEY: z.string().min(1, "INNGEST_SIGNING_KEY is required"),
  WORKER_PORT: z.coerce.number().int().positive().default(4500),

  // Phase 03 — the worker's own Postgres access. Rule B confines every query to
  // *.repository.ts files, but the connection itself is process-wide (packages/db/src/
  // client.ts reads DATABASE_URL directly at import time), so it is required at boot
  // here exactly as it is in apps/api.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Phase 03 — the GitHub App credentials the worker needs to mint its own installation
  // tokens for the tarball fetch (§9: GET /repos, GET tarball). Deliberately NOT
  // GITHUB_APP_SLUG or GITHUB_APP_WEBHOOK_SECRET: the worker never builds an install
  // link and never receives a webhook, so it has no use for either.
  GITHUB_APP_ID: z.string().min(1, "GITHUB_APP_ID is required"),
  GITHUB_APP_PRIVATE_KEY: githubAppPrivateKeySchema,
  REDIS_URL: githubRedisUrlSchema,

  // Phase 03 §19 — all three have code defaults, so none are required; exposed as env
  // vars purely so an MVP size limit can be tuned without a redeploy.
  WORKER_TEMP_DIR: z.string().min(1).optional(),
  INDEX_MAX_TOTAL_BYTES: z.coerce.number().int().positive().default(2 * GIB),
  INDEX_MAX_FILE_COUNT: z.coerce.number().int().positive().default(200_000),
});

export type Config = Readonly<z.infer<typeof envSchema>>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error);
    // Carries each field's first Zod message, not just its name — otherwise a mangled
    // GITHUB_APP_PRIVATE_KEY reads identically to a missing one (matches
    // apps/api/src/lib/config.ts, added there for the same variable).
    const missingOrInvalid = Object.entries(fieldErrors).map(([name, messages]) => {
      const reason = messages?.[0];
      return reason ? `${name} (${reason})` : name;
    });
    throw new ConfigError(`Invalid environment configuration — missing/invalid variable(s): ${missingOrInvalid.join(", ")}`);
  }
  return Object.freeze(parsed.data);
}
