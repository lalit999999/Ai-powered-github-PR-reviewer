import { GithubAccessRevokedError, GithubRateLimitError } from "@repo/github";
import { describe, expect, it, vi } from "vitest";
import { fetchTarballStream } from "./tarball-fetcher.js";

const INSTALLATION_ID = 424_242n;
const TOKEN = "ghs_fakeinstallationtokenfortarballtests";
const OWNER = "octocat";
const REPO = "hello-world";
const SHA = "a".repeat(40);
const CODELOAD_URL = `https://codeload.github.com/${OWNER}/${REPO}/legacy.tar.gz/${SHA}?token=super-secret-signed-token`;

function noopLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Records every call and plays back a fixed script of Response objects, one per call. */
function stubFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const response = responses[calls.length - 1];
    if (!response)
      throw new Error(
        `stubFetch: no scripted response for call #${calls.length.toString()} (${String(url)})`,
      );
    return response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function redirectResponse(
  location: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}

async function streamToString(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value).toString());
  }
  return chunks.join("");
}

describe("fetchTarballStream — the happy path", () => {
  it("follows the pinned redirect to codeload.github.com and streams the body", async () => {
    const codeloadBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("gzip-bytes-1"));
        controller.enqueue(new TextEncoder().encode("gzip-bytes-2"));
        controller.close();
      },
    });
    const { fn, calls } = stubFetch([
      redirectResponse(CODELOAD_URL, { "x-ratelimit-remaining": "4998" }),
      new Response(codeloadBody, { status: 200 }),
    ]);

    const result = await fetchTarballStream(INSTALLATION_ID, OWNER, REPO, SHA, {
      fetchImpl: fn,
      getToken: async () => TOKEN,
      logger: noopLogger(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(await streamToString(result.stream)).toBe(
      "gzip-bytes-1gzip-bytes-2",
    );

    // Exactly two calls — the metadata-equivalent cost lever this phase's §15 measures.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      `https://api.github.com/repos/${OWNER}/${REPO}/tarball/${SHA}`,
    );
    expect(
      (calls[0]?.init?.headers as Record<string, string>).authorization,
    ).toBe(`token ${TOKEN}`);
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[1]?.url).toBe(CODELOAD_URL);
    expect(calls[1]?.init?.redirect).toBe("error");
  });

  it("never logs the signed codeload URL or the installation token — only the host", async () => {
    const { fn } = stubFetch([
      redirectResponse(CODELOAD_URL),
      new Response(new ReadableStream(), { status: 200 }),
    ]);
    const logger = noopLogger();

    await fetchTarballStream(INSTALLATION_ID, OWNER, REPO, SHA, {
      fetchImpl: fn,
      getToken: async () => TOKEN,
      logger,
    });

    const allFieldValues = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.debug.mock.calls,
    ]
      .flatMap((call) =>
        Object.values((call[1] as Record<string, unknown>) ?? {}),
      )
      .map((value) => JSON.stringify(value));
    expect(
      allFieldValues.some((value) =>
        value.includes("super-secret-signed-token"),
      ),
    ).toBe(false);
    expect(allFieldValues.some((value) => value.includes(TOKEN))).toBe(false);
    expect(
      allFieldValues.some((value) => value === '"codeload.github.com"'),
    ).toBe(true);
  });
});

describe("fetchTarballStream — the pinned-host check (§4/§35.9)", () => {
  it("rejects a redirect to a non-codeload.github.com host without following it", async () => {
    const { fn, calls } = stubFetch([
      redirectResponse("https://evil.example.com/steal-the-token?x=1"),
    ]);

    const result = await fetchTarballStream(INSTALLATION_ID, OWNER, REPO, SHA, {
      fetchImpl: fn,
      getToken: async () => TOKEN,
      logger: noopLogger(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "UNSAFE_REDIRECT",
      host: "evil.example.com",
    });
    // The rejection happens before any second call — the malicious host is never touched.
    expect(calls).toHaveLength(1);
  });

  it("rejects a redirect to a look-alike host (codeload.github.com.evil.com)", async () => {
    const { fn, calls } = stubFetch([
      redirectResponse("https://codeload.github.com.evil.com/x"),
    ]);

    const result = await fetchTarballStream(INSTALLATION_ID, OWNER, REPO, SHA, {
      fetchImpl: fn,
      getToken: async () => TOKEN,
      logger: noopLogger(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "UNSAFE_REDIRECT",
      host: "codeload.github.com.evil.com",
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects a redirect with no Location header at all", async () => {
    const { fn } = stubFetch([new Response(null, { status: 302 })]);
    const result = await fetchTarballStream(INSTALLATION_ID, OWNER, REPO, SHA, {
      fetchImpl: fn,
      getToken: async () => TOKEN,
      logger: noopLogger(),
    });
    expect(result).toEqual({
      ok: false,
      reason: "UNSAFE_REDIRECT",
      host: "unknown",
    });
  });

  it("propagates a throw if codeload.github.com itself tries to redirect again (redirect: 'error' on the second hop)", async () => {
    // Simulates undici's real behavior for redirect:"error" hitting a redirect —
    // verified empirically (docs/decisions/phase-03-log.md): it rejects the fetch call
    // itself with a TypeError rather than resolving with a 3xx response.
    let call = 0;
    const fn = vi.fn(async () => {
      call += 1;
      if (call === 1) return redirectResponse(CODELOAD_URL);
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(
      fetchTarballStream(INSTALLATION_ID, OWNER, REPO, SHA, {
        fetchImpl: fn,
        getToken: async () => TOKEN,
        logger: noopLogger(),
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe("fetchTarballStream — error classification (§12)", () => {
  it("classifies a 404 as REPO_NOT_FOUND, non-retriably", async () => {
    const { fn } = stubFetch([new Response(null, { status: 404 })]);
    const result = await fetchTarballStream(INSTALLATION_ID, OWNER, REPO, SHA, {
      fetchImpl: fn,
      getToken: async () => TOKEN,
      logger: noopLogger(),
    });
    expect(result).toEqual({ ok: false, reason: "REPO_NOT_FOUND" });
  });

  it("classifies a 500 as a retriable throw — a plain Error, not GithubAccessRevokedError/GithubRateLimitError", async () => {
    const { fn } = stubFetch([new Response(null, { status: 500 })]);
    const promise = fetchTarballStream(INSTALLATION_ID, OWNER, REPO, SHA, {
      fetchImpl: fn,
      getToken: async () => TOKEN,
      logger: noopLogger(),
    });
    await expect(promise).rejects.toThrow(/500/);
    await expect(promise.catch((e: unknown) => e)).resolves.not.toBeInstanceOf(
      GithubAccessRevokedError,
    );
    await expect(promise.catch((e: unknown) => e)).resolves.not.toBeInstanceOf(
      GithubRateLimitError,
    );
  });

  it("propagates a network failure (fetch itself rejecting) as a retriable throw", async () => {
    const fn = vi.fn(async () => {
      throw new TypeError("fetch failed: ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(
      fetchTarballStream(INSTALLATION_ID, OWNER, REPO, SHA, {
        fetchImpl: fn,
        getToken: async () => TOKEN,
        logger: noopLogger(),
      }),
    ).rejects.toThrow(/ECONNRESET/);
  });

  it("throws GithubAccessRevokedError on a 401", async () => {
    const { fn } = stubFetch([new Response(null, { status: 401 })]);
    await expect(
      fetchTarballStream(INSTALLATION_ID, OWNER, REPO, SHA, {
        fetchImpl: fn,
        getToken: async () => TOKEN,
        logger: noopLogger(),
      }),
    ).rejects.toBeInstanceOf(GithubAccessRevokedError);
  });

  it("throws GithubAccessRevokedError on a 403 without rate-limit headers", async () => {
    const { fn } = stubFetch([new Response(null, { status: 403 })]);
    await expect(
      fetchTarballStream(INSTALLATION_ID, OWNER, REPO, SHA, {
        fetchImpl: fn,
        getToken: async () => TOKEN,
        logger: noopLogger(),
      }),
    ).rejects.toBeInstanceOf(GithubAccessRevokedError);
  });

  it("throws GithubRateLimitError, carrying the reset time, on a 403 WITH rate-limit headers", async () => {
    const { fn } = stubFetch([
      new Response(null, {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "retry-after": "90" },
      }),
    ]);
    const error = await fetchTarballStream(INSTALLATION_ID, OWNER, REPO, SHA, {
      fetchImpl: fn,
      getToken: async () => TOKEN,
      logger: noopLogger(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubRateLimitError);
    expect((error as GithubRateLimitError).details).toMatchObject({
      retryAfterSeconds: 90,
    });
  });

  it("propagates GithubAccessRevokedError thrown by the token mint itself, unchanged", async () => {
    const { fn } = stubFetch([]);
    const mintError = new GithubAccessRevokedError("revoked");
    await expect(
      fetchTarballStream(INSTALLATION_ID, OWNER, REPO, SHA, {
        fetchImpl: fn,
        getToken: async () => {
          throw mintError;
        },
        logger: noopLogger(),
      }),
    ).rejects.toBe(mintError);
  });
});
