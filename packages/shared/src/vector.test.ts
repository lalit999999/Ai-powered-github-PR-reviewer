import { describe, expect, it } from "vitest";
import { CHUNK_KINDS, HYBRID_WEIGHTS, isChunkKind } from "./vector.js";

describe("HYBRID_WEIGHTS", () => {
  it("sums to 1.0", () => {
    const sum = Object.values(HYBRID_WEIGHTS).reduce(
      (total, weight) => total + weight,
      0,
    );
    expect(sum).toBeCloseTo(1.0, 10);
  });
});

describe("isChunkKind", () => {
  it("accepts every member of CHUNK_KINDS", () => {
    for (const kind of CHUNK_KINDS) {
      expect(isChunkKind(kind)).toBe(true);
    }
  });

  it("rejects a plausible near-miss string", () => {
    expect(isChunkKind("FILE-HEADER")).toBe(false);
    expect(isChunkKind("file_header")).toBe(false);
    expect(isChunkKind("SYMBOLS")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isChunkKind(null)).toBe(false);
    expect(isChunkKind(undefined)).toBe(false);
    expect(isChunkKind(1)).toBe(false);
  });
});
