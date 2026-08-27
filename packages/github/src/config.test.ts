import { afterEach, describe, expect, it } from "vitest";
import {
  getGithubClientConfig,
  githubAppPrivateKeySchema,
  githubRedisUrlSchema,
  initGithubClient,
  resetGithubClientConfigForTesting,
} from "./config.js";

// The transform/refine behavior itself is exercised end-to-end through both consuming
// apps' own config.test.ts (apps/api/src/lib/config.test.ts, apps/worker/src/lib/config.test.ts)
// against their full env schemas. This file covers the schema in isolation — the one
// place it can be tested without also standing up an app's unrelated required
// variables — plus the init/get boot-time seam this package added in Phase 03.

const DUMMY_PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nnot-real-key-material\n-----END RSA PRIVATE KEY-----";
const DUMMY_PEM_BASE64 = Buffer.from(DUMMY_PEM).toString("base64");

describe("githubAppPrivateKeySchema", () => {
  it("decodes base64 into the real PEM", () => {
    expect(githubAppPrivateKeySchema.parse(DUMMY_PEM_BASE64)).toBe(DUMMY_PEM);
  });

  it("passes a raw PEM through unchanged", () => {
    expect(githubAppPrivateKeySchema.parse(DUMMY_PEM)).toBe(DUMMY_PEM);
  });

  it("rejects a value that is neither a PEM nor base64 of one", () => {
    expect(() =>
      githubAppPrivateKeySchema.parse("not-a-pem-and-not-base64-of-one"),
    ).toThrow(/malformed/);
  });
});

describe("githubRedisUrlSchema", () => {
  it.each([
    "redis://localhost:6379",
    "rediss://host:6380",
    "unix:///tmp/redis.sock",
  ])("accepts %s", (value) => {
    expect(githubRedisUrlSchema.parse(value)).toBe(value);
  });

  it("rejects a bare host:port with no scheme", () => {
    expect(() => githubRedisUrlSchema.parse("localhost:6379")).toThrow(
      /REDIS_URL/,
    );
  });
});

describe("initGithubClient / getGithubClientConfig", () => {
  afterEach(() => {
    resetGithubClientConfigForTesting();
  });

  it("throws before initGithubClient has been called", () => {
    expect(() => getGithubClientConfig()).toThrow(/initGithubClient/);
  });

  it("returns exactly what was passed to initGithubClient", () => {
    const config = {
      appId: "1",
      privateKey: DUMMY_PEM,
      redisUrl: "redis://localhost:6379",
    };
    initGithubClient(config);
    expect(getGithubClientConfig()).toEqual(config);
  });
});
