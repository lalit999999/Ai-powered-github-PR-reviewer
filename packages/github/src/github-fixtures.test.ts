import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import nock from "nock";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@repo/observability";
import { GithubAccessRevokedError, GithubRateLimitError, ServiceUnavailableError } from "./errors.js";
import {
  createInstallationTokenService,
  installationTokenCacheKey,
  TOKEN_CACHE_TTL_SECONDS,
  TOKEN_MINT_MAX_ATTEMPTS,
} from "./client/app-auth.js";
import { TokenCacheEtagStore } from "./client/etag-cache.js";
import { createInstallationOctokit } from "./client/octokit-factory.js";
import { InMemoryTokenCache } from "./client/token-cache.js";
import { listInstallationRepositories, listUserInstallations } from "./services/installation.github.js";
import { getRepository, probeBranch } from "./services/repository.github.js";

/**
 * Phase 02 Prompt 3, sub-tasks 3.1/3.2: the fixture-driven half of §14's automated
 * verification list.
 *
 * This is deliberately a different kind of test from the ones already in
 * `client/app-auth.test.ts`, `client/octokit-factory.test.ts`, and
 * `services/github-services.test.ts`. Those inject a fake `http`/`fetch` function or a
 * stub `Octokit` and assert against hand-built inline response objects — fast, but they
 * only prove "our code calls its injected seam correctly." This file instead leaves the
 * REAL default HTTP path in place (global `fetch`, i.e. Node 22's undici) and intercepts
 * it at the network boundary with `nock`, serving the JSON fixtures in
 * `tests/fixtures/github/`. What is under test here is whether the default client
 * actually speaks GitHub's protocol — real header names/casing, real query strings, a
 * real (if schema-derived, not recorded — see the fixtures' own README) response shape —
 * not just whether an injected stub was called with the right arguments.
 *
 * **nock, not msw** (`plan.md` §40.3 sanctions either). Verified empirically before
 * choosing: nock@14.0.17 successfully intercepts Node 22's global `fetch`
 * (`nock("https://x").get("/y").reply(200, {})` + a plain `fetch("https://x/y")` call
 * resolves from the mock, not the network) — worth checking rather than assuming, since
 * nock's classic interception patches the `http`/`https` core modules, which undici's
 * `fetch` implementation does not route through on its own; v14 added the additional
 * hook that makes this work. Recorded in docs/decisions/phase-02-log.md.
 *
 * Every fixture file this suite does not load is a fixture that was built for nothing —
 * each `tests/fixtures/github/*.json` is used by at least one test below.
 */

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tests/fixtures/github");

const GITHUB_API = "https://api.github.com";
const INSTALLATION_ID = 58234971n;
const FIXTURE_TOKEN = "FIXTURE-INSTALLATION-TOKEN-DO-NOT-USE";

interface FixtureResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Loads one `{status, headers, body}` fixture, substituting any `__NAME__` placeholder
 * in the raw text first. Used for values — a rate-limit reset timestamp, mainly — that
 * have to be relative to whenever the test actually runs rather than baked in once.
 */
function loadFixture(name: string, vars: Record<string, string> = {}): FixtureResponse {
  const raw = readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf8");
  const substituted = Object.entries(vars).reduce((text, [key, value]) => text.split(`__${key}__`).join(value), raw);
  return JSON.parse(substituted) as FixtureResponse;
}

function replyWithFixture(interceptor: nock.Interceptor, fixture: FixtureResponse): nock.Scope {
  return interceptor.reply(fixture.status, fixture.body as nock.Body, fixture.headers);
}

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

function fakeClock(startMs: number) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advanceSeconds(seconds: number) {
      nowMs += seconds * 1000;
    },
  };
}

/** A hermetic Octokit for the repository/installation service-layer tests: a fixed
 * token (no real mint), an in-memory ETag store (no real Redis) — regardless of whether
 * this environment happens to have a local Redis running. */
function fixtureOctokit(installationId: bigint, logger: ReturnType<typeof createLogger>) {
  return createInstallationOctokit(installationId, {
    getToken: async () => FIXTURE_TOKEN,
    etagStore: new TokenCacheEtagStore(new InMemoryTokenCache()),
    logger,
  });
}

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  // A leftover un-consumed interceptor means a test asserted a call happened that
  // actually didn't — fail loudly rather than let the next test's nock.cleanAll() hide it.
  expect(nock.pendingMocks()).toEqual([]);
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});

// ---------------------------------------------------------------------------
// Token minting — cache reuse, expiry boundary, rate limit, revocation, 5xx (§14)
// ---------------------------------------------------------------------------

describe("POST /app/installations/{id}/access_tokens — fixture-driven", () => {
  it("mints once and reuses the cached token on a second call — one JWT→token exchange, logged as miss then hit", async () => {
    const mint = loadFixture("access-token-success", { EXPIRES_AT: new Date(Date.now() + 3600_000).toISOString() });
    replyWithFixture(
      nock(GITHUB_API).post(`/app/installations/${INSTALLATION_ID}/access_tokens`).matchHeader("authorization", "Bearer fake.app.jwt"),
      mint,
    );

    const cache = new InMemoryTokenCache();
    const { logger, lines } = capturingLogger();
    const service = createInstallationTokenService({
      cache,
      createAppJwt: async () => "fake.app.jwt",
      logger,
    });

    const first = await service.getInstallationToken(INSTALLATION_ID);
    const second = await service.getInstallationToken(INSTALLATION_ID);

    expect(first).toBe((mint.body as { token: string }).token);
    expect(second).toBe(first);
    expect(await cache.get(installationTokenCacheKey(INSTALLATION_ID))).toBe(first);

    const outcomes = lines.map((line) => line.cache).filter(Boolean);
    expect(outcomes).toEqual(["miss", "hit"]);
  });

  it("re-mints a FRESH token at 50:01, having reused the cached one at 49:59 (§22 boundary, wired into the fixture harness)", async () => {
    const startMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    // expires_at is exactly 60 minutes past this clock's start, so the effective TTL
    // lands on the usual 50-minute cap.
    const mint1 = loadFixture("access-token-success", { EXPIRES_AT: new Date(startMs + 60 * 60 * 1000).toISOString() });
    const path1 = `/app/installations/${INSTALLATION_ID}/access_tokens`;
    replyWithFixture(nock(GITHUB_API).post(path1), mint1);
    replyWithFixture(nock(GITHUB_API).post(path1), {
      status: 201,
      headers: { "content-type": "application/json" },
      body: { token: "FIXTURE-INSTALLATION-TOKEN-SECOND-MINT", expires_at: "2026-01-01T14:00:00Z" },
    });

    const clock = fakeClock(startMs);
    const cache = new InMemoryTokenCache(clock.now);
    const service = createInstallationTokenService({
      cache,
      createAppJwt: async () => "fake.app.jwt",
      now: clock.now,
    });

    const first = await service.getInstallationToken(INSTALLATION_ID);
    expect(first).toBe(FIXTURE_TOKEN);

    clock.advanceSeconds(TOKEN_CACHE_TTL_SECONDS - 1); // 49:59 — still cached
    expect(await service.getInstallationToken(INSTALLATION_ID)).toBe(FIXTURE_TOKEN);

    clock.advanceSeconds(2); // 50:01 — past the cache TTL
    const second = await service.getInstallationToken(INSTALLATION_ID);
    expect(second).toBe("FIXTURE-INSTALLATION-TOKEN-SECOND-MINT");
    expect(second).not.toBe(first);
  });

  it("a rate-limited mint (403 + x-ratelimit-reset) fails fast as GithubRateLimitError rather than sleeping out the wait", async () => {
    const resetAtSeconds = Math.floor(Date.now() / 1000) + 90;
    const limited = loadFixture("access-token-403-rate-limited", { RATE_LIMIT_RESET: String(resetAtSeconds) });
    replyWithFixture(nock(GITHUB_API).post(`/app/installations/${INSTALLATION_ID}/access_tokens`), limited);

    const service = createInstallationTokenService({
      cache: new InMemoryTokenCache(),
      createAppJwt: async () => "fake.app.jwt",
    });

    const error = await service.getInstallationToken(INSTALLATION_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubRateLimitError);
    expect((error as GithubRateLimitError).details.retryAfterSeconds).toBe(90);
  });

  it("401 (revoked installation) is GithubAccessRevokedError and is never retried — exactly one request reaches GitHub", async () => {
    const revoked = loadFixture("access-token-401-revoked");
    replyWithFixture(nock(GITHUB_API).post(`/app/installations/${INSTALLATION_ID}/access_tokens`), revoked);

    const cache = new InMemoryTokenCache();
    const service = createInstallationTokenService({
      cache,
      createAppJwt: async () => "fake.app.jwt",
    });

    // Exactly one nock interceptor was registered above with no .times()/.persist();
    // disableNetConnect() means a retry would surface as a DIFFERENT (nock "no match")
    // error, so this assertion alone proves both the error type and the no-retry
    // behavior — a retry could not have produced a clean GithubAccessRevokedError here.
    await expect(service.getInstallationToken(INSTALLATION_ID)).rejects.toBeInstanceOf(GithubAccessRevokedError);
    expect(await cache.get(installationTokenCacheKey(INSTALLATION_ID))).toBeNull();
  });

  it("5xx is retried up to the attempt cap, then surfaces a clean ServiceUnavailableError rather than hanging", async () => {
    const failure = loadFixture("access-token-500");
    replyWithFixture(
      nock(GITHUB_API).post(`/app/installations/${INSTALLATION_ID}/access_tokens`).times(TOKEN_MINT_MAX_ATTEMPTS),
      failure,
    );

    const sleeps: number[] = [];
    const service = createInstallationTokenService({
      cache: new InMemoryTokenCache(),
      createAppJwt: async () => "fake.app.jwt",
      // Injected so this test asserts the backoff schedule without spending real time
      // on it — an actually-sleeping retry test is the flakiest test in a repo six
      // months from now (Prompt 3 §3.2 "On timing").
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(service.getInstallationToken(INSTALLATION_ID)).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(sleeps).toHaveLength(TOKEN_MINT_MAX_ATTEMPTS - 1);
  });

  it("never writes the minted token to the logs, on the success path or any failure path", async () => {
    const cases: Array<{ name: string; vars?: Record<string, string> }> = [
      { name: "access-token-success", vars: { EXPIRES_AT: new Date(Date.now() + 3600_000).toISOString() } },
      { name: "access-token-401-revoked" },
      { name: "access-token-403-rate-limited", vars: { RATE_LIMIT_RESET: String(Math.floor(Date.now() / 1000) + 60) } },
    ];

    for (const { name, vars } of cases) {
      const fixture = loadFixture(name, vars);
      const times = name === "access-token-success" ? 1 : 1;
      replyWithFixture(
        nock(GITHUB_API).post(`/app/installations/${INSTALLATION_ID}/access_tokens`).times(times),
        fixture,
      );

      const { logger, lines } = capturingLogger();
      const service = createInstallationTokenService({
        cache: new InMemoryTokenCache(),
        createAppJwt: async () => "fake.app.jwt",
        logger,
      });

      await service.getInstallationToken(INSTALLATION_ID).catch(() => undefined);

      expect(lines.length).toBeGreaterThan(0);
      expect(JSON.stringify(lines)).not.toContain(FIXTURE_TOKEN);
    }
  });
});

// ---------------------------------------------------------------------------
// The full chain — mint (fixture) → cache → authenticated GET (fixture)
// ---------------------------------------------------------------------------

describe("the full chain: a minted token flows unbroken into an authenticated GitHub call", () => {
  it("fetches a repository using the token that was just minted from the fixture", async () => {
    const mint = loadFixture("access-token-success", { EXPIRES_AT: new Date(Date.now() + 3600_000).toISOString() });
    const repo = loadFixture("repo-normal");
    const mintedToken = (mint.body as { token: string }).token;

    replyWithFixture(nock(GITHUB_API).post(`/app/installations/${INSTALLATION_ID}/access_tokens`), mint);
    replyWithFixture(
      nock(GITHUB_API).get("/repos/octocat/hello-world").matchHeader("authorization", `token ${mintedToken}`),
      repo,
    );

    const tokenService = createInstallationTokenService({
      cache: new InMemoryTokenCache(),
      createAppJwt: async () => "fake.app.jwt",
    });
    const octokit = createInstallationOctokit(INSTALLATION_ID, {
      getToken: tokenService.getInstallationToken,
      etagStore: new TokenCacheEtagStore(new InMemoryTokenCache()),
    });

    const result = await getRepository(INSTALLATION_ID, "octocat", "hello-world", { octokit });

    expect(result.ok).toBe(true);
    expect(result.ok && result.repository.fullName).toBe("octocat/hello-world");
  });
});

// ---------------------------------------------------------------------------
// Ordinary API calls — rate-limit scheduled retry, ETag 304 (§14/§21)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo} — rate limiting and ETag caching, fixture-driven", () => {
  it("a 403 with x-ratelimit-reset in the recent past is a SCHEDULED RETRY, not an immediate failure", async () => {
    // A reset a few seconds in the past makes @octokit/plugin-throttling compute a
    // near-zero wait (see docs/decisions/phase-02-log.md) — the retry is real and goes
    // through the actual throttling plugin, but the test does not sleep for it.
    const resetAtSeconds = Math.floor(Date.now() / 1000) - 5;
    const limited = loadFixture("repo-403-rate-limited", { RATE_LIMIT_RESET: String(resetAtSeconds) });
    const success = loadFixture("repo-normal");
    const { logger, lines } = capturingLogger();

    replyWithFixture(nock(GITHUB_API).get("/repos/octocat/hello-world"), limited);
    replyWithFixture(nock(GITHUB_API).get("/repos/octocat/hello-world"), success);

    const octokit = fixtureOctokit(INSTALLATION_ID, logger);
    const result = await getRepository(INSTALLATION_ID, "octocat", "hello-world", { octokit, logger });

    expect(result.ok).toBe(true);
    const rateLimitLine = lines.find((line) => line.msg === "github rate limit hit");
    expect(rateLimitLine?.willRetry).toBe(true);
  });

  it("stores the ETag from a 200 and serves the cached body on a matching 304 — no second full fetch", async () => {
    const repo = loadFixture("repo-normal");
    const etag = repo.headers.etag as string;
    const { logger } = capturingLogger();

    replyWithFixture(nock(GITHUB_API).get("/repos/octocat/hello-world"), repo);
    replyWithFixture(
      nock(GITHUB_API).get("/repos/octocat/hello-world").matchHeader("if-none-match", etag),
      { status: 304, headers: { etag }, body: undefined },
    );

    const octokit = fixtureOctokit(INSTALLATION_ID, logger);
    const first = await getRepository(INSTALLATION_ID, "octocat", "hello-world", { octokit, logger });
    const second = await getRepository(INSTALLATION_ID, "octocat", "hello-world", { octokit, logger });

    expect(first.ok && second.ok && second.repository).toEqual(first.ok && first.repository);
  });
});

// ---------------------------------------------------------------------------
// GET /installation/repositories — pagination past 100 (§14/§21)
// ---------------------------------------------------------------------------

describe("GET /installation/repositories — pagination, fixture-driven", () => {
  it("keeps paging until a short page, returning all 137 repositories across two pages", async () => {
    const page1 = loadFixture("installation-repositories-page-1");
    const page2 = loadFixture("installation-repositories-page-2");
    const { logger } = capturingLogger();

    replyWithFixture(nock(GITHUB_API).get("/installation/repositories").query({ per_page: "100", page: "1" }), page1);
    replyWithFixture(nock(GITHUB_API).get("/installation/repositories").query({ per_page: "100", page: "2" }), page2);

    const octokit = fixtureOctokit(INSTALLATION_ID, logger);
    const result = await listInstallationRepositories(INSTALLATION_ID, { octokit, logger });

    expect(result.ok).toBe(true);
    expect(result.ok && result.repositories).toHaveLength(137);
    expect(result.ok && result.repositories[0]?.fullName).toBe("acme-corp/service-1");
    expect(result.ok && result.repositories[136]?.fullName).toBe("acme-corp/service-137");
  });
});

// ---------------------------------------------------------------------------
// GET /user/installations — the user-OAuth call (§9)
// ---------------------------------------------------------------------------

describe("GET /user/installations — fixture-driven", () => {
  it("maps a realistic multi-installation response, including a suspended organization install", async () => {
    const installations = loadFixture("user-installations");
    replyWithFixture(nock(GITHUB_API).get("/user/installations").query({ per_page: "100", page: "1" }), installations);

    const result = await listUserInstallations("gho_fixture_oauth_token", { logger: createLogger("test") });

    expect(result.ok).toBe(true);
    expect(result.ok && result.installations).toEqual([
      { installationId: 58234971n, accountLogin: "octocat", accountType: "User", suspended: false },
      { installationId: 58234988n, accountLogin: "acme-corp", accountType: "Organization", suspended: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo} — the metadata variants sub-task 3.1 asks for by name
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo} — metadata variants, fixture-driven", () => {
  it("normal: maps a non-empty, under-cap, private-false repository", async () => {
    const { logger } = capturingLogger();
    const octokit = fixtureOctokit(INSTALLATION_ID, logger);
    replyWithFixture(nock(GITHUB_API).get("/repos/octocat/hello-world"), loadFixture("repo-normal"));

    const result = await getRepository(INSTALLATION_ID, "octocat", "hello-world", { octokit, logger });

    expect(result.ok && result.repository).toMatchObject({
      githubRepoId: 1296269n,
      fullName: "octocat/hello-world",
      defaultBranch: "main",
      isPrivate: false,
      sizeKib: 108,
    });
  });

  it("empty (ambiguous size:0 + a named default branch): the probe finds no commits on it", async () => {
    const { logger } = capturingLogger();
    const octokit = fixtureOctokit(INSTALLATION_ID, logger);
    replyWithFixture(nock(GITHUB_API).get("/repos/acme-corp/brand-new-repo"), loadFixture("repo-empty"));
    replyWithFixture(
      nock(GITHUB_API).get("/repos/acme-corp/brand-new-repo/branches/main"),
      loadFixture("branch-probe-empty-404"),
    );

    const metadataResult = await getRepository(INSTALLATION_ID, "acme-corp", "brand-new-repo", { octokit, logger });
    expect(metadataResult.ok && metadataResult.repository.sizeKib).toBe(0);
    expect(metadataResult.ok && metadataResult.repository.defaultBranch).toBe("main");

    const probe = await probeBranch(INSTALLATION_ID, "acme-corp", "brand-new-repo", "main", { octokit, logger });
    expect(probe).toBe("EMPTY");
  });

  it("oversized: maps a repository whose sizeKib is over the 500 MiB connect-time cap", async () => {
    const { logger } = capturingLogger();
    const octokit = fixtureOctokit(INSTALLATION_ID, logger);
    replyWithFixture(nock(GITHUB_API).get("/repos/acme-corp/monorepo-of-everything"), loadFixture("repo-oversized"));

    const result = await getRepository(INSTALLATION_ID, "acme-corp", "monorepo-of-everything", { octokit, logger });

    expect(result.ok && result.repository.sizeKib).toBeGreaterThan(500 * 1024);
  });

  it("private-no-access: a 404 from GitHub is NOT_ACCESSIBLE, not a crash and not a false 'not found'", async () => {
    const { logger } = capturingLogger();
    const octokit = fixtureOctokit(INSTALLATION_ID, logger);
    replyWithFixture(nock(GITHUB_API).get("/repos/acme-corp/secret-repo"), loadFixture("repo-not-accessible-404"));

    await expect(getRepository(INSTALLATION_ID, "acme-corp", "secret-repo", { octokit, logger })).resolves.toEqual({
      ok: false,
      reason: "NOT_ACCESSIBLE",
    });
  });

  it("fork with an unusual default branch: 'trunk' maps through with no special-casing needed", async () => {
    const { logger } = capturingLogger();
    const octokit = fixtureOctokit(INSTALLATION_ID, logger);
    replyWithFixture(nock(GITHUB_API).get("/repos/someuser/widget-service"), loadFixture("repo-fork-unusual-branch"));

    const result = await getRepository(INSTALLATION_ID, "someuser", "widget-service", { octokit, logger });

    expect(result.ok && result.repository.defaultBranch).toBe("trunk");
  });
});

// ---------------------------------------------------------------------------
// Sanitization — enforced now, while there is nothing real to leak
// ---------------------------------------------------------------------------

describe("fixtures never contain anything shaped like a real credential", () => {
  // Real GitHub token prefixes, each followed (in a genuine token) by a long
  // high-entropy suffix with no separators — `ghs_thisisafakeinstallationtokenvalue`,
  // the pre-existing convention in client/app-auth.test.ts, deliberately does NOT match
  // this: it is a prefix plus an obviously-fake, readable phrase, not 36+ characters of
  // unbroken base62. That is what lets a fixture use a realistic-*looking* placeholder
  // without tripping this guard on itself — see tests/fixtures/github/README.md.
  const TOKEN_SHAPES: Array<[string, RegExp]> = [
    ["classic PAT (ghp_)", /ghp_[A-Za-z0-9]{36,}/],
    ["OAuth token (gho_)", /gho_[A-Za-z0-9]{36,}/],
    ["user-to-server token (ghu_)", /ghu_[A-Za-z0-9]{36,}/],
    ["installation token (ghs_)", /ghs_[A-Za-z0-9]{36,}/],
    ["refresh token (ghr_)", /ghr_[A-Za-z0-9]{36,}/],
    ["fine-grained PAT (github_pat_)", /github_pat_[A-Za-z0-9_]{80,}/],
    ["a PEM private key header", /-----BEGIN/],
  ];

  const fixtureFiles = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".json"));

  it("found at least one fixture to scan — a suite that scans nothing proves nothing", () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  it.each(fixtureFiles)("%s contains nothing shaped like a real token or private key", (file) => {
    const contents = readFileSync(path.join(FIXTURES_DIR, file), "utf8");
    for (const [, pattern] of TOKEN_SHAPES) {
      expect(contents).not.toMatch(pattern);
    }
  });
});
