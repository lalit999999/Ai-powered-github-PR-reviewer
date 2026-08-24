import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@repo/observability";
import { etagCacheKey, TokenCacheEtagStore } from "./etag-cache.js";
import { createInstallationOctokit } from "./octokit-factory.js";
import { MAX_RATE_LIMIT_WAIT_SECONDS } from "./rate-limiter.js";
import { InMemoryTokenCache } from "./token-cache.js";

const INSTALLATION_ID = 424_242n;
const TOKEN = "ghs_fakeinstallationtokenforfactorytests";
const BASE_URL = "https://api.github.com";

interface StubResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * Builds a `fetch` stub that plays back a fixed script of responses, recording every
 * outgoing request. Octokit accepts a custom fetch via `request: { fetch }` (verified in
 * @octokit/core@7.0.7's OctokitOptions), which is the cleanest seam here — it exercises
 * the real plugins rather than mocking them out.
 */
function stubFetch(script: StubResponse[]) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  let call = 0;

  const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    requests.push({ url: String(url), headers });

    const next = script[Math.min(call, script.length - 1)] as StubResponse;
    call += 1;
    const body = next.body === undefined ? "" : JSON.stringify(next.body);
    return new Response(next.status === 304 ? null : body, {
      status: next.status,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  });

  return { fetchStub, requests, callCount: () => call };
}

function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  const instance = pino({ level: "debug", base: null, timestamp: false, messageKey: "msg" }, stream);
  return { logger: createLogger("github.client", instance), lines };
}

function makeClient(script: StubResponse[], overrides: Parameters<typeof createInstallationOctokit>[1] = {}) {
  const { fetchStub, requests } = stubFetch(script);
  const { logger, lines } = capturingLogger();
  const cache = new InMemoryTokenCache();
  const octokit = createInstallationOctokit(INSTALLATION_ID, {
    getToken: async () => TOKEN,
    etagStore: new TokenCacheEtagStore(cache),
    fetch: fetchStub as unknown as typeof fetch,
    logger,
    ...overrides,
  });
  return { octokit, fetchStub, requests, lines, cache };
}

describe("createInstallationOctokit — authentication", () => {
  it("authenticates every request with the installation token, resolved per request", async () => {
    const getToken = vi.fn(async () => TOKEN);
    const { octokit, requests } = makeClient(
      [{ status: 200, body: { full_name: "octocat/hello-world" } }, { status: 200, body: {} }],
      { getToken },
    );

    await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" });
    await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "other" });

    expect(requests[0]?.headers.authorization).toBe(`token ${TOKEN}`);
    // Resolved per request, not captured at construction — that is what keeps a
    // long-lived client from sending a token that expired 10 minutes ago.
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledWith(INSTALLATION_ID);
  });

  it("never writes the installation token into log output", async () => {
    const { octokit, lines } = makeClient([{ status: 200, body: { ok: true } }]);
    await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" });
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });
});

describe("createInstallationOctokit — retry on 5xx", () => {
  it("retries a 500 and succeeds when a later attempt works", async () => {
    const { octokit, fetchStub } = makeClient([
      { status: 500, body: { message: "Server Error" } },
      { status: 200, body: { full_name: "octocat/hello-world" } },
    ]);

    const response = await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" });

    expect(response.status).toBe(200);
    expect(fetchStub.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not retry a 404 — a missing repository does not become present", async () => {
    const { octokit, fetchStub } = makeClient([{ status: 404, body: { message: "Not Found" } }]);
    await expect(
      octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "nope" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe("createInstallationOctokit — rate limiting (§14)", () => {
  it("schedules a retry for a 403 carrying x-ratelimit-reset rather than failing immediately", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 1; // one second out — inside the ceiling
    const { octokit, fetchStub, lines } = makeClient([
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) },
        body: { message: "API rate limit exceeded" },
      },
      { status: 200, headers: { "x-ratelimit-remaining": "4998" }, body: { full_name: "octocat/hello-world" } },
    ]);

    const response = await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" });

    expect(response.status).toBe(200);
    expect(fetchStub.mock.calls.length).toBeGreaterThan(1);

    const rateLimitLine = lines.find((line) => line.msg === "github rate limit hit");
    expect(rateLimitLine).toBeDefined();
    expect(rateLimitLine?.willRetry).toBe(true);
    expect(rateLimitLine?.kind).toBe("primary");
    expect(rateLimitLine?.installationId).toBe(INSTALLATION_ID.toString());
  });

  it("refuses to sit out a reset window longer than the ceiling, and says so in the log", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + MAX_RATE_LIMIT_WAIT_SECONDS + 600;
    const { octokit, fetchStub, lines } = makeClient([
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) },
        body: { message: "API rate limit exceeded" },
      },
    ]);

    await expect(
      octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" }),
    ).rejects.toMatchObject({ status: 403 });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const rateLimitLine = lines.find((line) => line.msg === "github rate limit hit");
    expect(rateLimitLine?.willRetry).toBe(false);
    expect(Number(rateLimitLine?.retryAfterSeconds)).toBeGreaterThan(MAX_RATE_LIMIT_WAIT_SECONDS);
  });
});

describe("createInstallationOctokit — ETag conditional requests (§21)", () => {
  it("stores the ETag from a 200 and sends it as If-None-Match on the next identical read", async () => {
    const { octokit, requests, cache } = makeClient([
      { status: 200, headers: { etag: 'W/"abc123"' }, body: { full_name: "octocat/hello-world" } },
      { status: 304, headers: { etag: 'W/"abc123"' } },
    ]);

    await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" });
    expect(requests[0]?.headers["if-none-match"]).toBeUndefined();

    await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" });
    expect(requests[1]?.headers["if-none-match"]).toBe('W/"abc123"');

    const key = etagCacheKey(INSTALLATION_ID.toString(), "GET", `${BASE_URL}/repos/octocat/hello-world`);
    expect(await cache.get(key)).toContain("abc123");
  });

  it("returns the cached body on a 304 — as a 200, with no second full fetch", async () => {
    const { octokit } = makeClient([
      { status: 200, headers: { etag: 'W/"abc123"' }, body: { full_name: "octocat/hello-world", size: 42 } },
      { status: 304, headers: { etag: 'W/"abc123"' } },
    ]);

    const first = await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" });
    const second = await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" });

    expect(second.status).toBe(200);
    expect(second.data).toEqual(first.data);
    expect(second.data).toEqual({ full_name: "octocat/hello-world", size: 42 });
  });

  it("does not let the retry plugin treat a 304 as a failed request", async () => {
    // @octokit/request *throws* on 304. If the ETag plugin were registered outside the
    // retry plugin, every cache hit would be retried instead of served.
    const { octokit, fetchStub } = makeClient([
      { status: 200, headers: { etag: 'W/"abc123"' }, body: { ok: true } },
      { status: 304, headers: { etag: 'W/"abc123"' } },
    ]);

    await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" });
    const callsAfterFirst = fetchStub.mock.calls.length;
    await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" });

    expect(fetchStub.mock.calls.length).toBe(callsAfterFirst + 1);
  });

  it("does not send If-None-Match for a different URL under the same installation", async () => {
    const { octokit, requests } = makeClient([
      { status: 200, headers: { etag: 'W/"abc123"' }, body: { ok: true } },
      { status: 200, headers: { etag: 'W/"def456"' }, body: { ok: true } },
    ]);

    await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" });
    await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "different" });
    expect(requests[1]?.headers["if-none-match"]).toBeUndefined();
  });

  it("scopes cached entries per installation — one installation cannot serve another's body", async () => {
    const cache = new InMemoryTokenCache();
    const store = new TokenCacheEtagStore(cache);
    const scriptA = stubFetch([{ status: 200, headers: { etag: 'W/"abc123"' }, body: { secret: "installation-a" } }]);
    const scriptB = stubFetch([{ status: 200, headers: { etag: 'W/"zzz999"' }, body: { secret: "installation-b" } }]);

    const clientA = createInstallationOctokit(1n, {
      getToken: async () => TOKEN,
      etagStore: store,
      fetch: scriptA.fetchStub as unknown as typeof fetch,
    });
    const clientB = createInstallationOctokit(2n, {
      getToken: async () => TOKEN,
      etagStore: store,
      fetch: scriptB.fetchStub as unknown as typeof fetch,
    });

    await clientA.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "private" });
    await clientB.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "private" });

    // Installation B made a real request and never received A's If-None-Match header.
    expect(scriptB.requests[0]?.headers["if-none-match"]).toBeUndefined();
    expect(await cache.get(etagCacheKey("1", "GET", `${BASE_URL}/repos/octocat/private`))).toContain("abc123");
    expect(await cache.get(etagCacheKey("2", "GET", `${BASE_URL}/repos/octocat/private`))).toContain("zzz999");
  });

  it("does not attach a conditional header to a non-GET request", async () => {
    const { octokit, requests } = makeClient([
      { status: 200, headers: { etag: 'W/"abc123"' }, body: { ok: true } },
      { status: 201, body: { ok: true } },
    ]);

    await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" });
    await octokit.request("POST /repos/{owner}/{repo}/issues", { owner: "octocat", repo: "hello-world", title: "x" });
    expect(requests[1]?.headers["if-none-match"]).toBeUndefined();
  });
});

describe("createInstallationOctokit — observability (§20)", () => {
  it("logs component, installationId, endpoint, status, and the rate-limit number on success", async () => {
    const { octokit, lines } = makeClient([
      { status: 200, headers: { "x-ratelimit-remaining": "4321" }, body: { ok: true } },
    ]);
    await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" });

    const line = lines.find((l) => l.msg === "github request completed");
    expect(line?.component).toBe("github.client");
    expect(line?.installationId).toBe(INSTALLATION_ID.toString());
    expect(line?.endpoint).toBe("GET /repos/{owner}/{repo}");
    expect(line?.status).toBe(200);
    // A number, not a string interpolated into the message — Phase 16 reads this field.
    expect(line?.["github.rate_limit_remaining"]).toBe(4321);
  });

  it("logs x-ratelimit-remaining on failure too", async () => {
    const { octokit, lines } = makeClient([
      { status: 404, headers: { "x-ratelimit-remaining": "17" }, body: { message: "Not Found" } },
    ]);
    await octokit.request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "nope" }).catch(() => undefined);

    const line = lines.find((l) => l.msg === "github request failed");
    expect(line?.status).toBe(404);
    expect(line?.["github.rate_limit_remaining"]).toBe(17);
  });
});
