import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../lib/logger.js";
import { TokenCacheEtagStore } from "./client/etag-cache.js";
import { createInstallationOctokit } from "./client/octokit-factory.js";
import { InMemoryTokenCache } from "./client/token-cache.js";
import { getRepository } from "./services/repository.github.js";

/**
 * Phase 02 Prompt 3, sub-task 3.1: the GitHub fixture harness itself.
 *
 * This is deliberately a different kind of test from the ones already in
 * `client/app-auth.test.ts`, `client/octokit-factory.test.ts`, and
 * `services/github-services.test.ts`. Those inject a fake `http`/`fetch` function or a
 * stub `Octokit` and assert against hand-built inline response objects — fast, but they
 * only prove "our code calls its injected seam correctly." This file instead leaves the
 * REAL default HTTP path in place (global `fetch`, i.e. Node 22's undici) and intercepts
 * it at the network boundary with `nock`, serving the JSON fixtures in
 * `tests/fixtures/github/`. What is under test is whether the default client actually
 * speaks GitHub's protocol — real header names/casing, real query strings, a real (if
 * schema-derived, not recorded — see the fixtures' own README) response shape — not just
 * whether an injected stub was called with the right arguments.
 *
 * **nock, not msw** (`plan.md` §40.3 sanctions either). Verified empirically before
 * choosing: nock@14.0.17 successfully intercepts Node 22's global `fetch`
 * (`nock("https://x").get("/y").reply(200, {})` + a plain `fetch("https://x/y")` call
 * resolves from the mock, not the network) — worth checking rather than assuming, since
 * nock's classic interception patches the `http`/`https` core modules, which undici's
 * `fetch` implementation does not route through on its own; v14 added the additional
 * hook that makes this work. Recorded in docs/decisions/phase-02-log.md.
 *
 * Sub-task 3.2 adds the full required-cases table (token cache reuse, the expiry
 * boundary, rate limiting, ETag 304s, pagination, revocation, 5xx retry) on top of this
 * harness. This file, on its own, proves the harness itself: fixtures load and parse,
 * one of them can serve a real intercepted request end to end, and nothing in this
 * fixture corpus is shaped like a real credential.
 */

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/github");

const GITHUB_API = "https://api.github.com";
const INSTALLATION_ID = 58234971n;

interface FixtureResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Loads one `{status, headers, body}` fixture, substituting any `__NAME__` placeholder
 * in the raw text first. Used for values — a rate-limit reset timestamp, a token expiry
 * — that have to be relative to whenever the test actually runs rather than baked in
 * once (see tests/fixtures/github/README.md for the bug this caught).
 */
function loadFixture(name: string, vars: Record<string, string> = {}): FixtureResponse {
  const raw = readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf8");
  const substituted = Object.entries(vars).reduce((text, [key, value]) => text.split(`__${key}__`).join(value), raw);
  return JSON.parse(substituted) as FixtureResponse;
}

function replyWithFixture(interceptor: nock.Interceptor, fixture: FixtureResponse): nock.Scope {
  return interceptor.reply(fixture.status, fixture.body as nock.Body, fixture.headers);
}

/** A hermetic Octokit for the repository/installation service-layer tests: a fixed
 * token (no real mint), an in-memory ETag store (no real Redis) — regardless of whether
 * this environment happens to have a local Redis running. */
function fixtureOctokit(installationId: bigint, logger: ReturnType<typeof createLogger>) {
  return createInstallationOctokit(installationId, {
    getToken: async () => "FIXTURE-INSTALLATION-TOKEN-DO-NOT-USE",
    etagStore: new TokenCacheEtagStore(new InMemoryTokenCache()),
    logger,
  });
}

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  expect(nock.pendingMocks()).toEqual([]);
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});

describe("the harness itself: a fixture can serve a real intercepted request end to end", () => {
  it("GET /repos/{owner}/{repo} — the normal-repo fixture flows through the real client unmodified", async () => {
    const logger = createLogger("test");
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
});

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

  it.each(fixtureFiles)("%s parses as a valid {status, headers, body} fixture", (file) => {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURES_DIR, file), "utf8")) as FixtureResponse;
    expect(typeof fixture.status).toBe("number");
    expect(typeof fixture.headers).toBe("object");
    expect("body" in fixture).toBe(true);
  });

  it.each(fixtureFiles)("%s contains nothing shaped like a real token or private key", (file) => {
    const contents = readFileSync(path.join(FIXTURES_DIR, file), "utf8");
    for (const [, pattern] of TOKEN_SHAPES) {
      expect(contents).not.toMatch(pattern);
    }
  });
});
