import { githubAppPrivateKeySchema, githubRedisUrlSchema } from "@repo/github";
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
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  INNGEST_EVENT_KEY: z.string().min(1, "INNGEST_EVENT_KEY is required"),
  INNGEST_SIGNING_KEY: z.string().min(1, "INNGEST_SIGNING_KEY is required"),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().url(),

  // Phase 01 §19 — GitHub OAuth sign-in (Auth.js), never the repository-scoped GitHub
  // App token (Phase 02). See docs/decisions/phase-01-log.md for the AUTH_URL /
  // NEXTAUTH_URL naming decision.
  GITHUB_OAUTH_CLIENT_ID: z
    .string()
    .min(1, "GITHUB_OAUTH_CLIENT_ID is required"),
  GITHUB_OAUTH_CLIENT_SECRET: z
    .string()
    .min(1, "GITHUB_OAUTH_CLIENT_SECRET is required"),
  AUTH_SECRET: z.string().min(1, "AUTH_SECRET is required"),
  AUTH_URL: z
    .string()
    .url(
      "AUTH_URL must be the canonical origin apps/api is reachable at, e.g. http://localhost:4000",
    ),

  // Phase 02 §19 — the GitHub *App* (what repository data we may read), deliberately
  // NOT the OAuth App above (who is signed in). Two separate credentials, never
  // conflated — plan.md §45 names that conflation as a top failure point for this
  // phase. See docs/github-app-setup.md for how to obtain each of these.
  GITHUB_APP_ID: z.string().min(1, "GITHUB_APP_ID is required"),
  GITHUB_APP_PRIVATE_KEY: githubAppPrivateKeySchema,
  GITHUB_APP_SLUG: z.string().min(1, "GITHUB_APP_SLUG is required"),
  // Configured on the App now so it is ready for Phase 06; no code in this phase (or
  // any phase before 06) reads it. Required anyway, so a deployment can never reach
  // Phase 06's webhook endpoint without it already being set — phase-02 §19.
  GITHUB_APP_WEBHOOK_SECRET: z
    .string()
    .min(1, "GITHUB_APP_WEBHOOK_SECRET is required"),
  // Shared with apps/worker via @repo/github rather than re-derived here — see
  // docs/decisions/phase-03-log.md, sub-task 1.1/1.2.
  REDIS_URL: githubRedisUrlSchema,

  // Phase 05 prompt 3, sub-task 3.8 — apps/api only ever needs an embedding provider
  // for the flagged debug search panel (Prompt 5). Making EMBEDDING_API_KEY/
  // EMBEDDING_MODEL unconditionally required (the way apps/worker's config.ts does,
  // where every index run genuinely needs them) would break every existing deployment
  // and CI run for a debug-only feature nothing else in apps/api depends on. Both are
  // declared `.optional()` here and enforced conditionally below, via `superRefine`,
  // only when DEBUG_SEARCH_ENABLED=true — fail-fast stays true exactly where it
  // matters, with no false boot failure everywhere else.
  //
  // `z.enum(["true","false"])` + `.transform`, not `z.coerce.boolean()` — deliberately:
  // `z.coerce.boolean()` runs JS's own `Boolean(...)` coercion, under which the string
  // `"false"` is truthy (a non-empty string), which would make `DEBUG_SEARCH_ENABLED=false`
  // in a real `.env` file silently enable the feature it names. The enum forces the
  // literal string `"true"` and rejects anything else (falling back to the default).
  DEBUG_SEARCH_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  EMBEDDING_API_KEY: z.string().min(1).optional(),
  EMBEDDING_MODEL: z.string().min(1).optional(),
});

export type Config = Readonly<z.infer<typeof envSchema>>;

const configSchema = envSchema.superRefine((data, ctx) => {
  if (!data.DEBUG_SEARCH_ENABLED) return;
  if (!data.EMBEDDING_API_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["EMBEDDING_API_KEY"],
      message: "EMBEDDING_API_KEY is required when DEBUG_SEARCH_ENABLED=true",
    });
  }
  if (!data.EMBEDDING_MODEL) {
    ctx.addIssue({
      code: "custom",
      path: ["EMBEDDING_MODEL"],
      message: "EMBEDDING_MODEL is required when DEBUG_SEARCH_ENABLED=true",
    });
  }
});

/**
 * Pure — no side effects, safe to call from unit tests with a synthetic env object.
 * Throws ConfigError naming every missing/invalid variable (FR4). The real fail-fast boot
 * behavior (log + process.exit) lives in src/config/env.ts, which is the only place this
 * runs against the real process.env as a module-load side effect.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(source);
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error);
    // Name every offending variable *and* carry its first message, so a value that is
    // present but structurally wrong (a mangled GITHUB_APP_PRIVATE_KEY, say) says so at
    // boot instead of reading as "missing".
    const missingOrInvalid = Object.entries(fieldErrors).map(
      ([name, messages]) => {
        const reason = messages?.[0];
        return reason ? `${name} (${reason})` : name;
      },
    );
    throw new ConfigError(
      `Invalid environment configuration — missing/invalid variable(s): ${missingOrInvalid.join(", ")}`,
    );
  }
  return Object.freeze(parsed.data);
}
