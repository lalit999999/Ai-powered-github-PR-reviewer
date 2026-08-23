import { z } from "zod";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Mirrors apps/api/src/lib/config.ts's pattern (pure, side-effect-free; the fail-fast
 * process.exit lives in src/config/env.ts) — see docs/decisions/phase-01-log.md for
 * why apps/worker doesn't share apps/api's config module directly.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  INNGEST_EVENT_KEY: z.string().min(1, "INNGEST_EVENT_KEY is required"),
  INNGEST_SIGNING_KEY: z.string().min(1, "INNGEST_SIGNING_KEY is required"),
  WORKER_PORT: z.coerce.number().int().positive().default(4500),
});

export type Config = Readonly<z.infer<typeof envSchema>>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error);
    const missingOrInvalid = Object.keys(fieldErrors);
    throw new ConfigError(`Invalid environment configuration — missing/invalid variable(s): ${missingOrInvalid.join(", ")}`);
  }
  return Object.freeze(parsed.data);
}
