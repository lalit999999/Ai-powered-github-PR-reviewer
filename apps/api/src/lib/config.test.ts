import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const VALID_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/dev",
  INNGEST_EVENT_KEY: "key",
  INNGEST_SIGNING_KEY: "key",
  FRONTEND_URL: "http://localhost:3000",
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
    expect.assertions(4);
    try {
      loadConfig({});
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("INNGEST_EVENT_KEY");
      expect(message).toContain("INNGEST_SIGNING_KEY");
      expect(message).toContain("FRONTEND_URL");
    }
  });
});
