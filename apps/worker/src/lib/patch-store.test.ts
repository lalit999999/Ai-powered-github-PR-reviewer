import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH_INLINE_MAX_BYTES } from "@repo/shared";

// patch-blob.repository.ts imports @repo/db, which requires DATABASE_URL at import
// time (packages/db/src/client.ts) — mocked here so this stays a pure unit test,
// matching the established convention that *.repository.ts files are exercised for real
// only via Testcontainers integration tests, never unit-mocked-and-tested individually
// (see indexer.service.test.ts's own header comment for the identical reasoning).
const upsertBlob = vi.fn(
  async (_input: {
    reviewId: string;
    path: string;
    content: string;
    byteSize: number;
  }) => ({ id: "blob-1" }),
);
const findBlobContentById = vi.fn(async (_id: string): Promise<string | null> => null);

vi.mock("../reviews/patch-blob.repository.js", () => ({
  upsertBlob: (...args: Parameters<typeof upsertBlob>) => upsertBlob(...args),
  findBlobContentById: (...args: Parameters<typeof findBlobContentById>) =>
    findBlobContentById(...args),
}));

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

const { storePatch, resolvePatch } = await import("./patch-store.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("storePatch", () => {
  it("a small ASCII patch stores inline, patchBytes equals the byte length", async () => {
    const patch = "diff --git a/foo.ts b/foo.ts\n+hello\n";

    const result = await storePatch({
      reviewId: "review-1",
      path: "foo.ts",
      patch,
    });

    expect(result).toEqual({
      patchRef: `inline:${patch}`,
      patchBytes: Buffer.byteLength(patch, "utf8"),
    });
    expect(upsertBlob).not.toHaveBeenCalled();
  });

  it("a patch of exactly PATCH_INLINE_MAX_BYTES stays inline — the boundary is inclusive", async () => {
    const patch = "a".repeat(PATCH_INLINE_MAX_BYTES);

    const result = await storePatch({
      reviewId: "review-1",
      path: "foo.ts",
      patch,
    });

    expect(result.patchRef).toBe(`inline:${patch}`);
    expect(result.patchBytes).toBe(PATCH_INLINE_MAX_BYTES);
    expect(upsertBlob).not.toHaveBeenCalled();
  });

  it("one byte over the cap goes to blob storage", async () => {
    const patch = "a".repeat(PATCH_INLINE_MAX_BYTES + 1);
    upsertBlob.mockResolvedValueOnce({ id: "blob-over" });

    const result = await storePatch({
      reviewId: "review-1",
      path: "foo.ts",
      patch,
    });

    expect(result).toEqual({
      patchRef: "blob:blob-over",
      patchBytes: PATCH_INLINE_MAX_BYTES + 1,
    });
    expect(upsertBlob).toHaveBeenCalledWith({
      reviewId: "review-1",
      path: "foo.ts",
      content: patch,
      byteSize: PATCH_INLINE_MAX_BYTES + 1,
    });
    expect(logSpies.debug).toHaveBeenCalledWith(
      "patch exceeds the inline threshold — storing as a blob",
      expect.objectContaining({
        reviewId: "review-1",
        path: "foo.ts",
        byteSize: PATCH_INLINE_MAX_BYTES + 1,
      }),
    );
  });

  it("a multibyte patch whose .length is under the cap but whose byte length is over it goes to blob storage", async () => {
    // '€' (U+20AC) is ONE UTF-16 code unit (counted by .length) but THREE UTF-8 bytes.
    // 25,000 repeats: .length = 25,000 (well under the 65,536 cap), byte length =
    // 75,000 (well over it) — exactly the mismatch Buffer.byteLength exists to catch.
    const patch = "€".repeat(25_000);
    expect(patch.length).toBeLessThan(PATCH_INLINE_MAX_BYTES);
    const byteLength = Buffer.byteLength(patch, "utf8");
    expect(byteLength).toBeGreaterThan(PATCH_INLINE_MAX_BYTES);

    upsertBlob.mockResolvedValueOnce({ id: "blob-multibyte" });

    const result = await storePatch({
      reviewId: "review-1",
      path: "i18n.ts",
      patch,
    });

    expect(result).toEqual({
      patchRef: "blob:blob-multibyte",
      patchBytes: byteLength,
    });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
  ])("%s patch returns { patchRef: null, patchBytes: 0 }", async (_label, patch) => {
    const result = await storePatch({
      reviewId: "review-1",
      path: "foo.ts",
      patch,
    });

    expect(result).toEqual({ patchRef: null, patchBytes: 0 });
    expect(upsertBlob).not.toHaveBeenCalled();
  });

  it("upserts on (reviewId, path) — never a blind insert (Inngest step-retry idempotency)", async () => {
    const patch = "a".repeat(PATCH_INLINE_MAX_BYTES + 1);
    upsertBlob.mockResolvedValueOnce({ id: "blob-retry" });

    await storePatch({ reviewId: "review-2", path: "bar.ts", patch });
    await storePatch({ reviewId: "review-2", path: "bar.ts", patch });

    expect(upsertBlob).toHaveBeenCalledTimes(2);
    expect(upsertBlob.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ reviewId: "review-2", path: "bar.ts" }),
    );
  });
});

describe("resolvePatch", () => {
  it("round-trips an inline ref", async () => {
    const patch = "diff --git a/foo.ts b/foo.ts\n+hello\n";
    const stored = await storePatch({
      reviewId: "review-1",
      path: "foo.ts",
      patch,
    });

    await expect(resolvePatch(stored.patchRef)).resolves.toBe(patch);
  });

  it("round-trips a blob ref", async () => {
    findBlobContentById.mockResolvedValueOnce("the stored blob content");

    await expect(resolvePatch("blob:blob-1")).resolves.toBe(
      "the stored blob content",
    );
    expect(findBlobContentById).toHaveBeenCalledWith("blob-1");
  });

  it("returns null for a null ref", async () => {
    await expect(resolvePatch(null)).resolves.toBeNull();
    expect(findBlobContentById).not.toHaveBeenCalled();
  });

  it("returns null for a blob ref whose row no longer exists", async () => {
    findBlobContentById.mockResolvedValueOnce(null);

    await expect(resolvePatch("blob:gone")).resolves.toBeNull();
  });

  it("throws a clear error for an unrecognized scheme", async () => {
    await expect(resolvePatch("s3:whatever")).rejects.toThrow(
      /unrecognized patchRef scheme/,
    );
  });
});
