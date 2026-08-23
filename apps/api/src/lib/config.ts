import { z } from "zod";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Phase 00 §19 vars, plus PORT/FRONTEND_URL which this repo's Express-backend topology
 * needs (plan.md assumes Next.js Route Handlers with no separate port — see
 * docs/decisions/phase-00-log.md §1/§5). Extend with `.extend({...})` for Phase 01's OAuth
 * secrets — this shape is deliberately a plain z.object() so that slots in without rework
 * (phase-00 §22).
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  INNGEST_EVENT_KEY: z.string().min(1, "INNGEST_EVENT_KEY is required"),
  INNGEST_SIGNING_KEY: z.string().min(1, "INNGEST_SIGNING_KEY is required"),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().url(),

  // Phase 01 §19 — GitHub OAuth sign-in (Auth.js), never the repository-scoped GitHub
  // App token (Phase 02). See docs/decisions/phase-01-log.md for the AUTH_URL /
  // NEXTAUTH_URL naming decision.
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1, "GITHUB_OAUTH_CLIENT_ID is required"),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1, "GITHUB_OAUTH_CLIENT_SECRET is required"),
  AUTH_SECRET: z.string().min(1, "AUTH_SECRET is required"),
  AUTH_URL: z.string().url("AUTH_URL must be the canonical origin apps/api is reachable at, e.g. http://localhost:4000"),
});

export type Config = Readonly<z.infer<typeof envSchema>>;

/**
 * Pure — no side effects, safe to call from unit tests with a synthetic env object.
 * Throws ConfigError naming every missing/invalid variable (FR4). The real fail-fast boot
 * behavior (log + process.exit) lives in src/config/env.ts, which is the only place this
 * runs against the real process.env as a module-load side effect.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error);
    const missingOrInvalid = Object.keys(fieldErrors);
    throw new ConfigError(`Invalid environment configuration — missing/invalid variable(s): ${missingOrInvalid.join(", ")}`);
  }
  return Object.freeze(parsed.data);
}
