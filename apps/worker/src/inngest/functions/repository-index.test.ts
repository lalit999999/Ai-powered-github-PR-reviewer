import { GithubAccessRevokedError, GithubRateLimitError } from "@repo/github";
import { NonRetriableError } from "inngest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArchiveTooLargeError, UnsafeArchiveError } from "../../indexing/fetcher/archive-extractor.js";
import type { IndexRepositoryResult } from "../../indexing/indexer.service.js";

const indexRepository = vi.fn<() => Promise<IndexRepositoryResult>>();
vi.mock("../../indexing/indexer.service.js", () => ({
  indexRepository: (...args: unknown[]) => indexRepository(...(args as [])),
}));

const { parseCode, runFetchExtractPersist, withCode } = await import("./repository-index.js");

function okResult(overrides: Partial<Extract<IndexRepositoryResult, { ok: true }>> = {}): IndexRepositoryResult {
  return {
    ok: true,
    filesTotal: 10,
    filesIndexed: 8,
    filesProcessed: 9,
    filesFailed: 1,
    filesSkipped: 1,
    hardIgnoredCount: 3,
    hardIgnoreRatio: 0.1,
    staleRowsRemoved: 0,
    extraction: { filesWritten: 10, directoriesWritten: 2, totalBytes: 1000, skipped: [] },
    symbolsCreated: 20,
    edgesCreated: 15,
    parseFailureCount: 0,
    unresolvedImportRatio: 0.05,
    ...overrides,
  };
}

const ARGS = {
  installationId: 1n,
  owner: "octocat",
  repo: "hello-world",
  sha: "abc123",
  repositoryId: "repo-1",
  jobId: "job-1",
  attempt: 0,
};

beforeEach(() => {
  indexRepository.mockReset();
});

describe("withCode / parseCode — the round-trip the onFailure boundary depends on", () => {
  it("round-trips a code and message", () => {
    const encoded = withCode("REPO_NOT_FOUND", "the repository is gone");
    expect(parseCode(encoded)).toEqual({ code: "REPO_NOT_FOUND", message: "the repository is gone" });
  });

  it("falls back to UNKNOWN for a message with no recognizable prefix", () => {
    expect(parseCode("some random failure")).toEqual({ code: "UNKNOWN", message: "some random failure" });
  });

  it("falls back to UNKNOWN when the prefix looks like one but isn't a real code", () => {
    expect(parseCode("NOT_A_REAL_CODE: whatever")).toEqual({ code: "UNKNOWN", message: "NOT_A_REAL_CODE: whatever" });
  });

  it("preserves a message that itself contains the separator after the real code", () => {
    const encoded = withCode("UNSAFE_ARCHIVE", "path traversal: ../../etc/passwd rejected");
    expect(parseCode(encoded)).toEqual({ code: "UNSAFE_ARCHIVE", message: "path traversal: ../../etc/passwd rejected" });
  });
});

describe("runFetchExtractPersist", () => {
  it("returns { rateLimited: false, result } on success, slimmed to scalars only", async () => {
    indexRepository.mockResolvedValue(okResult());

    const outcome = await runFetchExtractPersist(ARGS);

    expect(outcome).toEqual({
      rateLimited: false,
      result: {
        filesTotal: 10,
        filesIndexed: 8,
        filesProcessed: 9,
        filesFailed: 1,
        filesSkipped: 1,
        hardIgnoredCount: 3,
        staleRowsRemoved: 0,
        symbolsCreated: 20,
        edgesCreated: 15,
        parseFailureCount: 0,
        unresolvedImportRatio: 0.05,
      },
    });
    // The extraction.skipped array (unbounded) must never appear in what a step returns.
    expect(outcome).not.toHaveProperty("result.extraction");
  });

  it("returns { rateLimited: true, retryAfterSeconds } rather than throwing for GithubRateLimitError", async () => {
    indexRepository.mockRejectedValue(new GithubRateLimitError("rate limited", { details: { retryAfterSeconds: 42 } }));

    const outcome = await runFetchExtractPersist(ARGS);

    expect(outcome).toEqual({ rateLimited: true, retryAfterSeconds: 42 });
  });

  it("defaults retryAfterSeconds to 60 when GitHub gave no usable reset value", async () => {
    indexRepository.mockRejectedValue(new GithubRateLimitError("rate limited", {}));

    const outcome = await runFetchExtractPersist(ARGS);

    expect(outcome).toEqual({ rateLimited: true, retryAfterSeconds: 60 });
  });

  it("throws NonRetriableError with REPO_NOT_FOUND for a REPO_NOT_FOUND tarball result", async () => {
    indexRepository.mockResolvedValue({ ok: false, reason: "REPO_NOT_FOUND" });

    await expect(runFetchExtractPersist(ARGS)).rejects.toMatchObject({
      constructor: NonRetriableError,
      message: expect.stringMatching(/^REPO_NOT_FOUND: /),
    });
  });

  it("throws NonRetriableError with UNSAFE_ARCHIVE for an UNSAFE_REDIRECT tarball result", async () => {
    indexRepository.mockResolvedValue({ ok: false, reason: "UNSAFE_REDIRECT", host: "evil.example.com" });

    await expect(runFetchExtractPersist(ARGS)).rejects.toMatchObject({
      constructor: NonRetriableError,
      message: expect.stringMatching(/^UNSAFE_ARCHIVE: /),
    });
  });

  it("throws NonRetriableError with UNSAFE_ARCHIVE for a thrown UnsafeArchiveError", async () => {
    indexRepository.mockRejectedValue(new UnsafeArchiveError("the archive contains an entry with an unsafe path"));

    await expect(runFetchExtractPersist(ARGS)).rejects.toMatchObject({
      constructor: NonRetriableError,
      message: expect.stringMatching(/^UNSAFE_ARCHIVE: /),
    });
  });

  it("throws NonRetriableError with REPO_TOO_LARGE for a thrown ArchiveTooLargeError", async () => {
    indexRepository.mockRejectedValue(new ArchiveTooLargeError("too big"));

    await expect(runFetchExtractPersist(ARGS)).rejects.toMatchObject({
      constructor: NonRetriableError,
      message: expect.stringMatching(/^REPO_TOO_LARGE: /),
    });
  });

  it("throws NonRetriableError with ACCESS_REVOKED for a thrown GithubAccessRevokedError", async () => {
    indexRepository.mockRejectedValue(new GithubAccessRevokedError("access revoked"));

    await expect(runFetchExtractPersist(ARGS)).rejects.toMatchObject({
      constructor: NonRetriableError,
      message: expect.stringMatching(/^ACCESS_REVOKED: /),
    });
  });

  it("re-throws a plain, unclassified error unchanged — Inngest's own per-step retry owns it", async () => {
    const plain = new Error("network reset");
    indexRepository.mockRejectedValue(plain);

    await expect(runFetchExtractPersist(ARGS)).rejects.toBe(plain);
  });
});
