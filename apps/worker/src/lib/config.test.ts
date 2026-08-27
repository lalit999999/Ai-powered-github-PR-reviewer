import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const DUMMY_PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nnot-real-key-material\n-----END RSA PRIVATE KEY-----";
const DUMMY_PEM_BASE64 = Buffer.from(DUMMY_PEM).toString("base64");

const VALID_ENV = {
  NODE_ENV: "test",
  INNGEST_EVENT_KEY: "key",
  INNGEST_SIGNING_KEY: "key",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/dev",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: DUMMY_PEM,
  REDIS_URL: "redis://localhost:6379",
};

describe("loadConfig", () => {
  it("returns a frozen, typed config when the environment is complete", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
    expect(config.LOG_LEVEL).toBe("info");
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("defaults NODE_ENV, LOG_LEVEL, and WORKER_PORT when they are omitted", () => {
    const { NODE_ENV: _omit, ...rest } = VALID_ENV;
    const config = loadConfig(rest);
    expect(config.NODE_ENV).toBe("development");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.WORKER_PORT).toBe(4500);
  });

  it("throws ConfigError naming every missing variable at once, given an empty environment", () => {
    expect.assertions(5);
    try {
      loadConfig({});
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("INNGEST_EVENT_KEY");
      expect(message).toContain("INNGEST_SIGNING_KEY");
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("GITHUB_APP_ID");
      expect(message).toContain("GITHUB_APP_PRIVATE_KEY");
    }
  });

  it("fails at boot naming GITHUB_APP_PRIVATE_KEY AND saying the key is malformed", () => {
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

  it("decodes the canonical base64-encoded PEM, same transform as apps/api", () => {
    const config = loadConfig({
      ...VALID_ENV,
      GITHUB_APP_PRIVATE_KEY: DUMMY_PEM_BASE64,
    });
    expect(config.GITHUB_APP_PRIVATE_KEY).toBe(DUMMY_PEM);
  });

  it("rejects a REDIS_URL with no scheme", () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, REDIS_URL: "localhost:6379" }),
    ).toThrow(/REDIS_URL/);
  });
});

describe("loadConfig — Phase 03 indexing limits (§19)", () => {
  it("defaults INDEX_MAX_TOTAL_BYTES to 2 GiB and INDEX_MAX_FILE_COUNT to 200,000", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.INDEX_MAX_TOTAL_BYTES).toBe(2 * 1024 ** 3);
    expect(config.INDEX_MAX_FILE_COUNT).toBe(200_000);
    expect(config.WORKER_TEMP_DIR).toBeUndefined();
  });

  it("accepts overrides for tuning without a redeploy", () => {
    const config = loadConfig({
      ...VALID_ENV,
      INDEX_MAX_TOTAL_BYTES: "1000",
      INDEX_MAX_FILE_COUNT: "50",
      WORKER_TEMP_DIR: "/scratch",
    });
    expect(config.INDEX_MAX_TOTAL_BYTES).toBe(1000);
    expect(config.INDEX_MAX_FILE_COUNT).toBe(50);
    expect(config.WORKER_TEMP_DIR).toBe("/scratch");
  });
});
