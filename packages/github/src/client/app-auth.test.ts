import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { GithubAccessRevokedError, GithubRateLimitError, ServiceUnavailableError } from "../../lib/errors.js";
import { createLogger } from "../../lib/logger.js";
import {
  createInstallationTokenService,
  effectiveTtlSeconds,
  installationTokenCacheKey,
  TOKEN_CACHE_TTL_SECONDS,
  TOKEN_EXPIRY_SAFETY_MARGIN_SECONDS,
  TOKEN_MINT_MAX_ATTEMPTS,
  type GithubHttpClient,
  type GithubHttpResponse,
} from "./app-auth.js";
import { InMemoryTokenCache } from "./token-cache.js";

const INSTALLATION_ID = 12_345_678n;
const TOKEN = "ghs_thisisafakeinstallationtokenvalue";
const START_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

function fakeClock(startMs = START_MS) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advanceSeconds(seconds: number) {
      nowMs += seconds * 1000;
    },
  };
}

/** A 201 shaped like GitHub's real access_tokens response. */
function mintResponse(token = TOKEN, expiresAtMs = START_MS + 60 * 60 * 1000): GithubHttpResponse {
  return {
    status: 201,
    headers: { "x-ratelimit-remaining": "4999" },
    body: { token, expires_at: new Date(expiresAtMs).toISOString(), permissions: { contents: "read" } },
  };
}

/** Captures every emitted log line so tests can assert on real output, not on spies. */
function capturingLogger(component = "github.client") {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  const instance = pino({ level: "debug", base: null, timestamp: false, messageKey: "msg" }, stream);
  return { logger: createLogger(component, instance), lines };
}

interface Harness {
  http: ReturnType<typeof vi.fn>;
  clock: ReturnType<typeof fakeClock>;
  cache: InMemoryTokenCache;
  sleeps: number[];
  lines: Record<string, unknown>[];
  service: ReturnType<typeof createInstallationTokenService>;
}

function harness(responses: (GithubHttpResponse | Error)[]): Harness {
  const clock = fakeClock();
  const cache = new InMemoryTokenCache(clock.now);
  const sleeps: number[] = [];
  const { logger, lines } = capturingLogger();

  let call = 0;
  const http = vi.fn<GithubHttpClient>(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (next instanceof Error) throw next;
    return next as GithubHttpResponse;
  });

  const service = createInstallationTokenService({
    cache,
    http: http as unknown as GithubHttpClient,
    createAppJwt: async () => "fake.app.jwt",
    now: clock.now,
    // Backoff is recorded, never actually awaited — the retry test must not take a second.
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    logger,
  });

  return { http, clock, cache, sleeps, lines, service };
}

// The boundary tests below deliberately express their timings in terms of
// TOKEN_CACHE_TTL_SECONDS, so the constant and its regression test can never drift
// apart. That alone would let someone widen the margin to GitHub's full 60 minutes and
// still see green, so the *value* of the constant is pinned separately, here.
describe("the token-cache margin constant itself (plan.md §45 named failure point)", () => {
  const GITHUB_TOKEN_LIFETIME_SECONDS = 60 * 60;

  it("is 50 minutes", () => {
    expect(TOKEN_CACHE_TTL_SECONDS).toBe(50 * 60);
  });

  it("leaves real margin under GitHub's own 60-minute expiry, so a token cannot die mid-call", () => {
    expect(TOKEN_CACHE_TTL_SECONDS).toBeLessThan(GITHUB_TOKEN_LIFETIME_SECONDS);
    expect(GITHUB_TOKEN_LIFETIME_SECONDS - TOKEN_CACHE_TTL_SECONDS).toBeGreaterThanOrEqual(10 * 60);
  });

  it("never caches a token for its full stated lifetime, even when GitHub says 60 minutes", () => {
    const ttl = effectiveTtlSeconds(START_MS + GITHUB_TOKEN_LIFETIME_SECONDS * 1000, START_MS);
    expect(ttl).toBeLessThan(GITHUB_TOKEN_LIFETIME_SECONDS);
  });
});

describe("effectiveTtlSeconds", () => {
  it("uses the 50-minute cap when GitHub's expires_at is the usual 60 minutes away", () => {
    expect(effectiveTtlSeconds(START_MS + 60 * 60 * 1000, START_MS)).toBe(TOKEN_CACHE_TTL_SECONDS);
  });

  it("falls back to the cap when GitHub sends no parseable expires_at", () => {
    expect(effectiveTtlSeconds(null, START_MS)).toBe(TOKEN_CACHE_TTL_SECONDS);
  });

  it("shortens the TTL when GitHub says the token expires sooner than we assumed (clock-skew defense)", () => {
    // GitHub says 20 minutes, not 60. Local arithmetic would have cached for 50.
    const ttl = effectiveTtlSeconds(START_MS + 20 * 60 * 1000, START_MS);
    expect(ttl).toBe(20 * 60 - TOKEN_EXPIRY_SAFETY_MARGIN_SECONDS);
    expect(ttl).toBeLessThan(TOKEN_CACHE_TTL_SECONDS);
  });

  it("never returns a negative TTL for an already-expired token", () => {
    expect(effectiveTtlSeconds(START_MS - 5 * 60 * 1000, START_MS)).toBe(0);
  });
});

describe("getInstallationToken — cache behavior", () => {
  it("mints on a cache miss and stores the token under an installation-scoped key", async () => {
    const h = harness([mintResponse()]);
    expect(await h.service.getInstallationToken(INSTALLATION_ID)).toBe(TOKEN);
    expect(h.http).toHaveBeenCalledTimes(1);
    expect(await h.cache.get(installationTokenCacheKey(INSTALLATION_ID))).toBe(TOKEN);
  });

  it("reuses the cached token on a second call without a second HTTP request", async () => {
    const h = harness([mintResponse()]);
    await h.service.getInstallationToken(INSTALLATION_ID);
    await h.service.getInstallationToken(INSTALLATION_ID);
    expect(h.http).toHaveBeenCalledTimes(1);
  });

  it("logs cache hit and cache miss as distinct events (§20)", async () => {
    const h = harness([mintResponse()]);
    await h.service.getInstallationToken(INSTALLATION_ID);
    await h.service.getInstallationToken(INSTALLATION_ID);

    const outcomes = h.lines.map((line) => line.cache).filter(Boolean);
    expect(outcomes).toEqual(["miss", "hit"]);
    const mintLine = h.lines.find((line) => line.cache === "miss");
    expect(mintLine?.component).toBe("github.client");
    expect(mintLine?.installationId).toBe(INSTALLATION_ID.toString());
    expect(mintLine?.endpoint).toBe(`/app/installations/${INSTALLATION_ID}/access_tokens`);
    expect(mintLine?.status).toBe(201);
  });

  it("re-mints after invalidate()", async () => {
    const h = harness([mintResponse()]);
    await h.service.getInstallationToken(INSTALLATION_ID);
    await h.service.invalidate(INSTALLATION_ID);
    await h.service.getInstallationToken(INSTALLATION_ID);
    expect(h.http).toHaveBeenCalledTimes(2);
  });

  it("keys the cache per installation — two installations never share a token", async () => {
    const h = harness([mintResponse("token-a"), mintResponse("token-b")]);
    expect(await h.service.getInstallationToken(1n)).toBe("token-a");
    expect(await h.service.getInstallationToken(2n)).toBe("token-b");
    expect(h.http).toHaveBeenCalledTimes(2);
  });
});

// phase-02 §22 / plan.md §45's named failure point for this phase, asserted at the exact
// boundary the phase document names. These reference TOKEN_CACHE_TTL_SECONDS rather than
// a literal 50, so changing the constant changes the test's expectation with it.
describe("getInstallationToken — the 50-minute expiry boundary (§22)", () => {
  it("reuses the cached token at 49:59", async () => {
    const h = harness([mintResponse()]);
    await h.service.getInstallationToken(INSTALLATION_ID);

    h.clock.advanceSeconds(TOKEN_CACHE_TTL_SECONDS - 1); // 49:59
    expect(await h.service.getInstallationToken(INSTALLATION_ID)).toBe(TOKEN);
    expect(h.http).toHaveBeenCalledTimes(1);
  });

  it("mints a FRESH token at 50:01 — a new HTTP request, not a stale cached value", async () => {
    const h = harness([mintResponse(TOKEN), mintResponse("ghs_secondfreshtoken", START_MS + 3 * 60 * 60 * 1000)]);
    expect(await h.service.getInstallationToken(INSTALLATION_ID)).toBe(TOKEN);

    h.clock.advanceSeconds(TOKEN_CACHE_TTL_SECONDS + 1); // 50:01
    const second = await h.service.getInstallationToken(INSTALLATION_ID);

    expect(h.http).toHaveBeenCalledTimes(2);
    expect(second).toBe("ghs_secondfreshtoken");
    expect(second).not.toBe(TOKEN);
  });

  it("expires early when GitHub's expires_at is shorter than the 50-minute assumption", async () => {
    // GitHub says the token dies in 20 minutes. The effective TTL must be 19:00
    // (20 min minus the safety margin), not 50:00.
    const h = harness([
      mintResponse(TOKEN, START_MS + 20 * 60 * 1000),
      mintResponse("ghs_afterearlyexpiry", START_MS + 3 * 60 * 60 * 1000),
    ]);
    await h.service.getInstallationToken(INSTALLATION_ID);

    h.clock.advanceSeconds(20 * 60 - TOKEN_EXPIRY_SAFETY_MARGIN_SECONDS - 1); // 18:59
    expect(await h.service.getInstallationToken(INSTALLATION_ID)).toBe(TOKEN);
    expect(h.http).toHaveBeenCalledTimes(1);

    h.clock.advanceSeconds(2); // 19:01 — past the shortened TTL, still well inside 50:00
    expect(await h.service.getInstallationToken(INSTALLATION_ID)).toBe("ghs_afterearlyexpiry");
    expect(h.http).toHaveBeenCalledTimes(2);
  });
});

describe("getInstallationToken — failure handling (§12)", () => {
  it("retries a 5xx exactly 3 times with exponential backoff, then throws ServiceUnavailableError", async () => {
    const h = harness([{ status: 500, headers: {}, body: { message: "Server Error" } }]);
    await expect(h.service.getInstallationToken(INSTALLATION_ID)).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(h.http).toHaveBeenCalledTimes(TOKEN_MINT_MAX_ATTEMPTS);
    expect(h.sleeps).toEqual([250, 500]); // two waits between three attempts
  });

  it("surfaces a clean, user-safe message after exhausting retries rather than hanging", async () => {
    const h = harness([{ status: 503, headers: {}, body: null }]);
    await expect(h.service.getInstallationToken(INSTALLATION_ID)).rejects.toThrow(/GitHub is temporarily unavailable/);
  });

  it("retries a network-layer failure the same way a 5xx is retried", async () => {
    const h = harness([new Error("ECONNRESET")]);
    await expect(h.service.getInstallationToken(INSTALLATION_ID)).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(h.http).toHaveBeenCalledTimes(TOKEN_MINT_MAX_ATTEMPTS);
  });

  it("recovers if a retry succeeds, without surfacing the transient failure", async () => {
    const h = harness([{ status: 502, headers: {}, body: null }, mintResponse()]);
    expect(await h.service.getInstallationToken(INSTALLATION_ID)).toBe(TOKEN);
    expect(h.http).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 401 — it means the installation was revoked", async () => {
    const h = harness([{ status: 401, headers: {}, body: { message: "Bad credentials" } }]);
    await expect(h.service.getInstallationToken(INSTALLATION_ID)).rejects.toBeInstanceOf(GithubAccessRevokedError);
    expect(h.http).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it("carries a message the UI can show for a revoked installation", async () => {
    const h = harness([{ status: 401, headers: {}, body: null }]);
    await expect(h.service.getInstallationToken(INSTALLATION_ID)).rejects.toThrow(/revoked/i);
  });

  it("treats a rate-limited 403 as rate limiting, NOT as revocation", async () => {
    const resetAtSeconds = Math.floor(START_MS / 1000) + 90;
    const h = harness([
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAtSeconds) },
        body: { message: "API rate limit exceeded" },
      },
    ]);

    const error = await h.service.getInstallationToken(INSTALLATION_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubRateLimitError);
    expect(error).not.toBeInstanceOf(GithubAccessRevokedError);
    expect((error as GithubRateLimitError).details.retryAfterSeconds).toBe(90);
  });

  it("prefers retry-after over x-ratelimit-reset when GitHub sends both", async () => {
    const h = harness([
      {
        status: 429,
        headers: { "retry-after": "42", "x-ratelimit-reset": String(Math.floor(START_MS / 1000) + 3600) },
        body: null,
      },
    ]);
    const error = await h.service.getInstallationToken(INSTALLATION_ID).catch((e: unknown) => e);
    expect((error as GithubRateLimitError).details.retryAfterSeconds).toBe(42);
  });

  it("treats a 403 WITHOUT rate-limit headers as a suspended installation", async () => {
    const h = harness([{ status: 403, headers: {}, body: { message: "This installation has been suspended" } }]);
    await expect(h.service.getInstallationToken(INSTALLATION_ID)).rejects.toBeInstanceOf(GithubAccessRevokedError);
    expect(h.http).toHaveBeenCalledTimes(1);
  });

  it("does not cache anything when minting fails", async () => {
    const h = harness([{ status: 401, headers: {}, body: null }]);
    await h.service.getInstallationToken(INSTALLATION_ID).catch(() => undefined);
    expect(await h.cache.get(installationTokenCacheKey(INSTALLATION_ID))).toBeNull();
  });

  it("logs x-ratelimit-remaining as a structured number on failure (§20)", async () => {
    const h = harness([{ status: 500, headers: { "x-ratelimit-remaining": "17" }, body: null }]);
    await h.service.getInstallationToken(INSTALLATION_ID).catch(() => undefined);
    const failureLine = h.lines.find((line) => line.status === 500);
    expect(failureLine?.["github.rate_limit_remaining"]).toBe(17);
  });
});

// phase-02 §15: "Installation tokens are never persisted to Postgres or written to
// logs." An assertion is the only thing that keeps the second half of that true.
describe("getInstallationToken — the token never reaches the logs", () => {
  it("emits no log line containing the token, on success or on any failure path", async () => {
    const cases: (GithubHttpResponse | Error)[][] = [
      [mintResponse()],
      [{ status: 401, headers: {}, body: { token: TOKEN } }],
      [{ status: 500, headers: {}, body: { token: TOKEN } }],
      [{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" }, body: { token: TOKEN } }],
    ];

    for (const responses of cases) {
      const h = harness(responses);
      await h.service.getInstallationToken(INSTALLATION_ID).catch(() => undefined);
      // Two calls, so the cache-hit path is covered too.
      await h.service.getInstallationToken(INSTALLATION_ID).catch(() => undefined);

      expect(h.lines.length).toBeGreaterThan(0);
      expect(JSON.stringify(h.lines)).not.toContain(TOKEN);
    }
  });

  it("never writes the App JWT to the logs either", async () => {
    const h = harness([mintResponse()]);
    await h.service.getInstallationToken(INSTALLATION_ID);
    expect(JSON.stringify(h.lines)).not.toContain("fake.app.jwt");
  });

  it("sends the App JWT as a Bearer credential to the access_tokens endpoint", async () => {
    const h = harness([mintResponse()]);
    await h.service.getInstallationToken(INSTALLATION_ID);
    expect(h.http).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
        headers: expect.objectContaining({ authorization: "Bearer fake.app.jwt" }),
      }),
    );
  });
});
