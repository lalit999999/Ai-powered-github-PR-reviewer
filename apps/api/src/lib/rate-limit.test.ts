import { beforeEach, describe, expect, it, vi } from "vitest";

const redisMock = { incr: vi.fn(), expire: vi.fn(), ttl: vi.fn() };
vi.mock("./redis.js", () => ({ getRedisClient: () => redisMock }));

const logSpies = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
vi.mock("@repo/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/observability")>();
  return { ...actual, createLogger: () => logSpies };
});

const { checkRateLimit } = await import("./rate-limit.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkRateLimit", () => {
  it("allows the request and sets an expiry on the very first increment", async () => {
    redisMock.incr.mockResolvedValue(1);

    const result = await checkRateLimit("repo-index:repo-1", 10);

    expect(result).toEqual({ allowed: true });
    expect(redisMock.expire).toHaveBeenCalledTimes(1);
  });

  it("allows requests up to and including the limit, without re-setting the expiry", async () => {
    redisMock.incr.mockResolvedValue(10);

    const result = await checkRateLimit("repo-index:repo-1", 10);

    expect(result).toEqual({ allowed: true });
    expect(redisMock.expire).not.toHaveBeenCalled();
  });

  it("rejects once the count exceeds the limit, with a retryAfterSeconds from the key's TTL", async () => {
    redisMock.incr.mockResolvedValue(11);
    redisMock.ttl.mockResolvedValue(1800);

    const result = await checkRateLimit("repo-index:repo-1", 10);

    expect(result).toEqual({ allowed: false, retryAfterSeconds: 1800 });
  });

  it("falls back to the full window when TTL is unavailable (-1/-2)", async () => {
    redisMock.incr.mockResolvedValue(11);
    redisMock.ttl.mockResolvedValue(-1);

    const result = await checkRateLimit("repo-index:repo-1", 10);

    expect(result).toEqual({ allowed: false, retryAfterSeconds: 3600 });
  });

  it("fails open and logs a warning when Redis is unreachable", async () => {
    redisMock.incr.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await checkRateLimit("repo-index:repo-1", 10);

    expect(result).toEqual({ allowed: true });
    expect(logSpies.warn).toHaveBeenCalledWith(
      "rate limit check failed — failing open",
      expect.objectContaining({ key: "repo-index:repo-1" }),
    );
  });

  it("scopes the Redis key to the caller-supplied key", async () => {
    redisMock.incr.mockResolvedValue(1);

    await checkRateLimit("repo-index:repo-42", 10);

    expect(redisMock.incr).toHaveBeenCalledWith(
      expect.stringContaining("repo-index:repo-42"),
    );
  });

  it("defaults the window to 3600 seconds when omitted", async () => {
    redisMock.incr.mockResolvedValue(11);
    redisMock.ttl.mockResolvedValue(-1);

    const result = await checkRateLimit("repo-index:repo-1", 10);

    // The TTL fallback is only reached via the default window — proves 3600 is still
    // the value in play when the caller passes nothing.
    expect(result).toEqual({ allowed: false, retryAfterSeconds: 3600 });
  });

  it("a custom window produces a different Redis key bucket than the default window", async () => {
    redisMock.incr.mockResolvedValue(1);

    await checkRateLimit("webhook:installation:999", 100, 60);
    const customWindowKey = redisMock.incr.mock.calls[0]?.[0] as string;

    redisMock.incr.mockClear();
    await checkRateLimit("webhook:installation:999", 100);
    const defaultWindowKey = redisMock.incr.mock.calls[0]?.[0] as string;

    expect(customWindowKey).not.toBe(defaultWindowKey);
    expect(customWindowKey).toContain(":60:");
    expect(defaultWindowKey).toContain(":3600:");
  });

  it("enforces the limit within a custom window", async () => {
    redisMock.incr.mockResolvedValue(101);
    redisMock.ttl.mockResolvedValue(45);

    const result = await checkRateLimit("webhook:installation:999", 100, 60);

    expect(result).toEqual({ allowed: false, retryAfterSeconds: 45 });
  });
});
