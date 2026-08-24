import { z } from "zod";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

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
 * The decode + shape check happens *here*, at boot, rather than at the first GitHub
 * call: a key that only fails when someone connects a repository is exactly the class of
 * late failure this repo's fail-fast config exists to prevent (phase-00 §19/FR4).
 */
const githubAppPrivateKeySchema = z
  .string()
  .min(1, "GITHUB_APP_PRIVATE_KEY is required")
  // Buffer.from(_, "base64") never throws — it drops non-base64 characters — so garbage
  // decodes to garbage and is caught by the PEM shape check below, not by a try/catch.
  .transform((raw) => {
    const value = raw.trim();
    return PEM_HEADER.test(value) ? value : Buffer.from(value, "base64").toString("utf8");
  })
  .refine((pem) => PEM_HEADER.test(pem) && PEM_FOOTER.test(pem), MALFORMED_KEY_MESSAGE);

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
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(1, "GITHUB_APP_WEBHOOK_SECRET is required"),
  // z.url() alone is too weak here: `new URL("localhost:6379")` parses happily (scheme
  // "localhost:"), so the common typo of omitting the scheme would sail through boot and
  // fail at connect time instead. Pin the schemes the client actually speaks.
  REDIS_URL: z
    .string()
    .url("REDIS_URL must be a URL, e.g. redis://localhost:6379")
    .refine(
      (value) => /^(rediss?|unix):\/\//.test(value),
      "REDIS_URL must start with redis://, rediss://, or unix:// — e.g. redis://localhost:6379",
    ),
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
    // Name every offending variable *and* carry its first message, so a value that is
    // present but structurally wrong (a mangled GITHUB_APP_PRIVATE_KEY, say) says so at
    // boot instead of reading as "missing".
    const missingOrInvalid = Object.entries(fieldErrors).map(([name, messages]) => {
      const reason = messages?.[0];
      return reason ? `${name} (${reason})` : name;
    });
    throw new ConfigError(`Invalid environment configuration — missing/invalid variable(s): ${missingOrInvalid.join(", ")}`);
  }
  return Object.freeze(parsed.data);
}
