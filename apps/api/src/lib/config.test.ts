import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const DUMMY_PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nnot-real-key-material\n-----END RSA PRIVATE KEY-----";
const DUMMY_PEM_BASE64 = Buffer.from(DUMMY_PEM).toString("base64");

const VALID_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/dev",
  INNGEST_EVENT_KEY: "key",
  INNGEST_SIGNING_KEY: "key",
  FRONTEND_URL: "http://localhost:3000",
  // Phase 01 §19 — added alongside DATABASE_URL etc. rather than a separate fixture,
  // per the "extend, don't rebuild" instruction for Prompt 1's tests.
  GITHUB_OAUTH_CLIENT_ID: "client-id",
  GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
  AUTH_SECRET: "a-secret-at-least-32-characters-long",
  AUTH_URL: "http://localhost:4000",
  // Phase 02 §19 — the GitHub App credentials. Not a real key: loadConfig only checks
  // the PEM envelope's shape, never parses the key material (that is app-auth's job).
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: DUMMY_PEM,
  GITHUB_APP_SLUG: "my-reviewer-app",
  GITHUB_APP_WEBHOOK_SECRET: "webhook-secret",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadConfig", () => {
  it("returns a frozen, typed config when the environment is complete", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
    expect(config.LOG_LEVEL).toBe("info");
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("defaults NODE_ENV and LOG_LEVEL when they are omitted", () => {
    const { NODE_ENV: _omit, ...rest } = VALID_ENV;
    const config = loadConfig(rest);
    expect(config.NODE_ENV).toBe("development");
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("throws ConfigError naming DATABASE_URL when only it is missing", () => {
    const { DATABASE_URL: _omit, ...rest } = VALID_ENV;
    expect(() => loadConfig(rest)).toThrow(ConfigError);
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it("throws ConfigError naming every missing variable at once, given an empty environment", () => {
    expect.assertions(8);
    try {
      loadConfig({});
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("INNGEST_EVENT_KEY");
      expect(message).toContain("INNGEST_SIGNING_KEY");
      expect(message).toContain("FRONTEND_URL");
      expect(message).toContain("GITHUB_OAUTH_CLIENT_ID");
      expect(message).toContain("GITHUB_OAUTH_CLIENT_SECRET");
      expect(message).toContain("AUTH_SECRET");
      expect(message).toContain("AUTH_URL");
    }
  });
});

// Phase 02 §19. The GitHub App private key is the one variable in this schema whose
// *shape* matters as much as its presence: a PEM mangled by an env loader would
// otherwise only surface on the first GitHub call, long after boot.
describe("loadConfig — GITHUB_APP_PRIVATE_KEY encoding", () => {
  it("decodes the canonical base64-encoded PEM into a real multi-line PEM", () => {
    const config = loadConfig({
      ...VALID_ENV,
      GITHUB_APP_PRIVATE_KEY: DUMMY_PEM_BASE64,
    });
    expect(config.GITHUB_APP_PRIVATE_KEY).toBe(DUMMY_PEM);
    expect(config.GITHUB_APP_PRIVATE_KEY).toContain("\n");
  });

  it("passes a raw PEM through unchanged (local dev convenience)", () => {
    const config = loadConfig({
      ...VALID_ENV,
      GITHUB_APP_PRIVATE_KEY: DUMMY_PEM,
    });
    expect(config.GITHUB_APP_PRIVATE_KEY).toBe(DUMMY_PEM);
  });

  it("fails at boot naming the variable AND saying the key is malformed", () => {
    expect.assertions(3);
    try {
      loadConfig({
        ...VALID_ENV,
        GITHUB_APP_PRIVATE_KEY: "not-a-pem-and-not-base64-of-one",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain("GITHUB_APP_PRIVATE_KEY");
      expect((err as Error).message).toContain("malformed");
    }
  });

  it("rejects a PEM whose footer was truncated by a copy/paste", () => {
    const truncated = "-----BEGIN RSA PRIVATE KEY-----\nabc";
    expect(() =>
      loadConfig({ ...VALID_ENV, GITHUB_APP_PRIVATE_KEY: truncated }),
    ).toThrow(/malformed/);
  });
});

describe("loadConfig — Phase 02 variables are all required", () => {
  it.each([
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_WEBHOOK_SECRET",
    "REDIS_URL",
  ] as const)("refuses to load when %s is missing, naming it", (variable) => {
    const { [variable]: _omit, ...rest } = VALID_ENV;
    expect(() => loadConfig(rest)).toThrow(ConfigError);
    expect(() => loadConfig(rest)).toThrow(new RegExp(variable));
  });

  it("rejects a REDIS_URL that is not a URL", () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, REDIS_URL: "localhost:6379" }),
    ).toThrow(/REDIS_URL/);
  });
});
