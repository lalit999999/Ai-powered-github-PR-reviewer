import { GRAPH_PROXIMITY, HYBRID_WEIGHTS } from "@repo/shared";
import { describe, expect, it } from "vitest";
import {
  graphProximityFor,
  normalizeLexicalScore,
  normalizeVectorScore,
  PATH_AFFINITY_TIERS,
  pathAffinity,
  recencyOrImportance,
  rescoreAndRank,
  scoreChunk,
  type HybridCandidate,
} from "./hybrid-scorer.js";

/**
 * Phase 05 prompt 2, sub-task 2.4: unit tests for the pure hybrid-scoring module.
 * No Prisma, no I/O, no Testcontainers — this suite runs under `pnpm --filter @repo/db
 * test:unit`.
 */

function candidate(overrides: Partial<HybridCandidate>): HybridCandidate {
  return {
    id: "c1",
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 10,
    chunkKind: "SYMBOL",
    content: "content",
    symbols: [],
    packageName: null,
    distance: null,
    tsRank: null,
    inboundEdgeCount: 0,
    isExported: false,
    ...overrides,
  };
}

describe("HYBRID_WEIGHTS sum to 1.0", () => {
  it("re-asserts the invariant this module's correctness depends on", () => {
    const sum =
      HYBRID_WEIGHTS.vectorScore +
      HYBRID_WEIGHTS.graphProximity +
      HYBRID_WEIGHTS.lexicalScore +
      HYBRID_WEIGHTS.recencyOrImportance +
      HYBRID_WEIGHTS.pathAffinity;
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe("normalizeVectorScore", () => {
  it("maps distance 0 (identical) to score 1", () => {
    expect(normalizeVectorScore(0)).toBe(1);
  });
  it("maps distance 2 (maximally dissimilar) to score 0", () => {
    expect(normalizeVectorScore(2)).toBe(0);
  });
  it("maps distance 1 to score 0.5", () => {
    expect(normalizeVectorScore(1)).toBe(0.5);
  });
  it("clamps a distance above 2 (floating-point overshoot) to 0, not negative", () => {
    expect(normalizeVectorScore(2.0001)).toBe(0);
  });
});

describe("normalizeLexicalScore — set-relative normalization", () => {
  it("the best match in the set scores 1.0", () => {
    expect(normalizeLexicalScore(0.05, 0.05)).toBe(1);
  });
  it("a zero max (no lexical matches) returns 0, no divide-by-zero", () => {
    expect(normalizeLexicalScore(0, 0)).toBe(0);
    expect(Number.isFinite(normalizeLexicalScore(0, 0))).toBe(true);
  });
  it("doubling every ts_rank in the set does not change the relative score", () => {
    const a = normalizeLexicalScore(0.02, 0.05);
    const b = normalizeLexicalScore(0.04, 0.1);
    expect(a).toBeCloseTo(b, 10);
  });
});

describe("graphProximityFor", () => {
  it("falls back to GRAPH_PROXIMITY.NONE when no map is supplied", () => {
    expect(graphProximityFor("src/a.ts", undefined)).toBe(GRAPH_PROXIMITY.NONE);
  });
  it("falls back to GRAPH_PROXIMITY.NONE when the path has no entry", () => {
    expect(graphProximityFor("src/a.ts", { "src/b.ts": 1.0 })).toBe(
      GRAPH_PROXIMITY.NONE,
    );
  });
  it("returns the supplied proximity when present", () => {
    expect(graphProximityFor("src/a.ts", { "src/a.ts": 0.7 })).toBe(0.7);
  });
});

describe("recencyOrImportance", () => {
  it("a chunk with max fan-in and isExported scores 1.0", () => {
    expect(
      recencyOrImportance({ inboundEdgeCount: 10, isExported: true }, 10),
    ).toBe(1);
  });
  it("a chunk with zero fan-in and not exported scores 0.0", () => {
    expect(
      recencyOrImportance({ inboundEdgeCount: 0, isExported: false }, 10),
    ).toBe(0);
  });
  it("a zero max in the set (no fan-in anywhere) does not divide by zero", () => {
    const result = recencyOrImportance(
      { inboundEdgeCount: 0, isExported: true },
      0,
    );
    expect(result).toBe(0.5); // export-ness alone, fan-in term is 0
  });
});

describe("pathAffinity", () => {
  it("same directory scores SAME_DIRECTORY", () => {
    expect(pathAffinity("src/a.ts", "src/b.ts", null, null)).toBe(
      PATH_AFFINITY_TIERS.SAME_DIRECTORY,
    );
  });
  it("different directory, same package scores SAME_PACKAGE", () => {
    expect(pathAffinity("src/pkg-a/x.ts", "src/pkg-b/y.ts", "pkg", "pkg")).toBe(
      PATH_AFFINITY_TIERS.SAME_PACKAGE,
    );
  });
  it("different directory, different package scores OTHER", () => {
    expect(
      pathAffinity("src/pkg-a/x.ts", "src/pkg-b/y.ts", "pkg-a", "pkg-b"),
    ).toBe(PATH_AFFINITY_TIERS.OTHER);
  });
  it("no reference path scores NO_REFERENCE, not OTHER", () => {
    expect(pathAffinity("src/a.ts", null, null, null)).toBe(
      PATH_AFFINITY_TIERS.NO_REFERENCE,
    );
  });
});

describe("scoreChunk — the weighted sum", () => {
  it("a chunk perfect on all five components scores 1.0", () => {
    const score = scoreChunk({
      vectorScore: 1,
      graphProximity: 1,
      lexicalScore: 1,
      recencyOrImportance: 1,
      pathAffinity: 1,
    });
    expect(score).toBeCloseTo(1, 10);
  });

  it("a chunk zero on all five components scores 0.0", () => {
    const score = scoreChunk({
      vectorScore: 0,
      graphProximity: 0,
      lexicalScore: 0,
      recencyOrImportance: 0,
      pathAffinity: 0,
    });
    expect(score).toBe(0);
  });

  it("each component in isolation moves the total by exactly its weight", () => {
    const zero = {
      vectorScore: 0,
      graphProximity: 0,
      lexicalScore: 0,
      recencyOrImportance: 0,
      pathAffinity: 0,
    };
    expect(scoreChunk({ ...zero, vectorScore: 1 })).toBeCloseTo(
      HYBRID_WEIGHTS.vectorScore,
      10,
    );
    expect(scoreChunk({ ...zero, graphProximity: 1 })).toBeCloseTo(
      HYBRID_WEIGHTS.graphProximity,
      10,
    );
    expect(scoreChunk({ ...zero, lexicalScore: 1 })).toBeCloseTo(
      HYBRID_WEIGHTS.lexicalScore,
      10,
    );
    expect(scoreChunk({ ...zero, recencyOrImportance: 1 })).toBeCloseTo(
      HYBRID_WEIGHTS.recencyOrImportance,
      10,
    );
    expect(scoreChunk({ ...zero, pathAffinity: 1 })).toBeCloseTo(
      HYBRID_WEIGHTS.pathAffinity,
      10,
    );
  });
});

describe("rescoreAndRank", () => {
  const baseContext = {
    queryFilePath: null,
    queryPackageName: null,
    limit: 10,
  };

  it("returns an empty array for an empty candidate set, no divide-by-zero", () => {
    expect(rescoreAndRank([], baseContext)).toEqual([]);
  });

  it("set-relative lexical normalization: doubling every ts_rank does not change ranking, changing one does", () => {
    const candidates = [
      candidate({ id: "a", distance: 0, tsRank: 0.02 }),
      candidate({ id: "b", distance: 0, tsRank: 0.04 }),
    ];
    const doubled = candidates.map((c) => ({
      ...c,
      tsRank: c.tsRank === null ? null : c.tsRank * 2,
    }));

    const rankedIds = (list: HybridCandidate[]) =>
      rescoreAndRank(list, baseContext).map((r) => r.id);

    expect(rankedIds(candidates)).toEqual(rankedIds(doubled));

    const changedOne = [
      candidate({ id: "a", distance: 0, tsRank: 0.02 }),
      candidate({ id: "b", distance: 0, tsRank: 0.5 }),
    ];
    // b's tsRank grew much larger than a's — b should now rank at or above a on the
    // lexical term (both have identical distance, so this is decisive).
    const changedRanked = rescoreAndRank(changedOne, baseContext);
    expect(changedRanked[0]!.id).toBe("b");
  });

  it("breaks exact ties deterministically by ascending id", () => {
    const candidates = [
      candidate({ id: "z", distance: 0.5, tsRank: null }),
      candidate({ id: "a", distance: 0.5, tsRank: null }),
      candidate({ id: "m", distance: 0.5, tsRank: null }),
    ];
    const ranked = rescoreAndRank(candidates, baseContext);
    expect(ranked.map((r) => r.id)).toEqual(["a", "m", "z"]);

    // Re-running with a different input order produces the identical output order —
    // proof the tiebreak is deterministic, not input-order-dependent.
    const reordered = rescoreAndRank([...candidates].reverse(), baseContext);
    expect(reordered.map((r) => r.id)).toEqual(["a", "m", "z"]);
  });

  it("respects the limit and populates every score component", () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      candidate({ id: `c${i.toString()}`, distance: i * 0.1 }),
    );
    const ranked = rescoreAndRank(candidates, { ...baseContext, limit: 2 });
    expect(ranked).toHaveLength(2);
    for (const r of ranked) {
      expect(typeof r.vectorScore).toBe("number");
      expect(typeof r.graphProximity).toBe("number");
      expect(typeof r.lexicalScore).toBe("number");
      expect(typeof r.recencyOrImportance).toBe("number");
      expect(typeof r.pathAffinity).toBe("number");
      expect(r.score).toBeCloseTo(
        HYBRID_WEIGHTS.vectorScore * r.vectorScore +
          HYBRID_WEIGHTS.graphProximity * r.graphProximity +
          HYBRID_WEIGHTS.lexicalScore * r.lexicalScore +
          HYBRID_WEIGHTS.recencyOrImportance * r.recencyOrImportance +
          HYBRID_WEIGHTS.pathAffinity * r.pathAffinity,
        10,
      );
    }
  });

  it("null distance/tsRank contribute 0, not a fabricated value", () => {
    const [result] = rescoreAndRank(
      [candidate({ id: "a", distance: null, tsRank: null })],
      baseContext,
    );
    expect(result!.vectorScore).toBe(0);
    expect(result!.lexicalScore).toBe(0);
  });
});
