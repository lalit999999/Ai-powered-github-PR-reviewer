import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePatch } from "./patch-parser.js";
import {
  buildDiffPositionMap,
  isCommentable,
  positionFor,
  snapToCommentable,
  type DiffPositionMap,
} from "./diff-position-map.js";

/**
 * Sub-task 3.2 — the priority test suite for the highest-risk module in Phase 07. Every
 * expectation below is hand-computed and written down as a comment next to the assertion,
 * never derived by calling `buildDiffPositionMap`/`parsePatch` first and reading off the
 * result. See `apps/worker/tests/fixtures/patches/ten-hunk.patch`'s own header comment for
 * the full per-hunk, per-line hand derivation the first describe block below checks.
 */

const FIXTURES_DIR = path.join(fileURLToPath(new URL(".", import.meta.url)), "../../tests/fixtures/patches");

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

describe("buildDiffPositionMap — the 10-hunk hand-verified fixture", () => {
  const patch = readFixture("ten-hunk.patch");
  const parsed = parsePatch(patch);
  const map = buildDiffPositionMap(parsed);

  it("parses all 10 hunks", () => {
    expect(parsed.hunks).toHaveLength(10);
    expect(map.empty).toBe(false);
  });

  it("every hunk's oldStart/oldEnd/newStart/newEnd matches the fixture's hand derivation", () => {
    // Hand-computed (fixture header): oldEnd = oldStart + oldLines - 1 (or oldStart - 1
    // when oldLines is 0); newEnd = newStart + newLines - 1 (or newStart - 1 when
    // newLines is 0). H4 is deletion-only (newEnd < newStart); H5 is addition-only
    // (oldEnd < oldStart).
    expect(map.hunks).toEqual([
      { oldStart: 1, oldEnd: 3, newStart: 1, newEnd: 4 }, // H1: @@ -1,3 +1,4 @@
      { oldStart: 10, oldEnd: 11, newStart: 11, newEnd: 13 }, // H2: @@ -10,2 +11,3 @@
      { oldStart: 20, oldEnd: 23, newStart: 22, newEnd: 23 }, // H3: @@ -20,4 +22,2 @@
      { oldStart: 34, oldEnd: 36, newStart: 34, newEnd: 33 }, // H4: @@ -34,3 +34,0 @@ (deletion-only)
      { oldStart: 45, oldEnd: 44, newStart: 42, newEnd: 43 }, // H5: @@ -45,0 +42,2 @@ (addition-only)
      { oldStart: 55, oldEnd: 59, newStart: 54, newEnd: 58 }, // H6: @@ -55,5 +54,5 @@
      { oldStart: 70, oldEnd: 71, newStart: 69, newEnd: 71 }, // H7: @@ -70,2 +69,3 @@
      { oldStart: 82, oldEnd: 84, newStart: 82, newEnd: 83 }, // H8: @@ -82,3 +82,2 @@
      { oldStart: 95, oldEnd: 98, newStart: 94, newEnd: 97 }, // H9: @@ -95,4 +94,4 @@
      { oldStart: 109, oldEnd: 110, newStart: 108, newEnd: 110 }, // H10: @@ -109,2 +108,3 @@
    ] satisfies DiffPositionMap["hunks"]);
  });

  it("commentableRight is every hunk's +/context newLine, sorted ascending, deduplicated", () => {
    // Hand-computed per hunk (fixture header "per-hunk old/new line numbers"):
    //   H1: 1(ctxA),2(new1),3(new2),4(ctxB)
    //   H2: 11(ctxA),12(new),13(ctxB)
    //   H3: 22(ctxA),23(ctxB)                    -- H3 is del-heavy: no + lines
    //   H4: (none — deletion-only hunk)
    //   H5: 42(new1),43(new2)
    //   H6: 54(ctxA),55(ctxB),56(new),57(ctxC),58(ctxD)
    //   H7: 69(ctxA),70(new),71(ctxB)
    //   H8: 82(ctxA),83(ctxB)
    //   H9: 94(ctxA),95(new1),96(new2),97(ctxB)
    //   H10: 108(ctxA),109(new),110(ctxB)
    expect(map.commentableRight).toEqual([
      1, 2, 3, 4, 11, 12, 13, 22, 23, 42, 43, 54, 55, 56, 57, 58, 69, 70, 71, 82, 83, 94, 95, 96, 97, 108, 109, 110,
    ]);
  });

  it("commentableLeft is every hunk's -/context oldLine, sorted ascending, deduplicated", () => {
    // Hand-computed per hunk:
    //   H1: 1(ctxA),2(old),3(ctxB)
    //   H2: 10(ctxA),11(ctxB)
    //   H3: 20(ctxA),21(old1),22(old2),23(ctxB)
    //   H4: 34(old1),35(old2),36(old3)
    //   H5: (none — addition-only hunk)
    //   H6: 55(ctxA),56(ctxB),57(old),58(ctxC),59(ctxD)
    //   H7: 70(ctxA),71(ctxB)
    //   H8: 82(ctxA),83(old),84(ctxB)
    //   H9: 95(ctxA),96(old1),97(old2),98(ctxB)
    //   H10: 109(ctxA),110(ctxB)
    expect(map.commentableLeft).toEqual([
      1, 2, 3, 10, 11, 20, 21, 22, 23, 34, 35, 36, 55, 56, 57, 58, 59, 70, 71, 82, 83, 84, 95, 96, 97, 98, 109, 110,
    ]);
  });

  it("positionByNewLine matches the fixture's hand-tallied position for every hunk", () => {
    // Hand-computed by combining the fixture header's position tally (which line gets
    // which position) with its per-hunk new-line-number tally (which line gets which
    // newLine) — at least one line per hunk, in fact every RIGHT-commentable line:
    //   H1 pos1=newLine1, pos3=newLine2, pos4=newLine3, pos5=newLine4
    //   H2 pos7=newLine11, pos8=newLine12, pos9=newLine13
    //   H3 pos11=newLine22, pos14=newLine23
    //   H4 (no new-side entries — deletion-only)
    //   H5 pos20=newLine42, pos21=newLine43
    //   H6 pos23=newLine54, pos24=newLine55, pos26=newLine56, pos27=newLine57, pos28=newLine58
    //   H7 pos30=newLine69, pos31=newLine70, pos32=newLine71
    //   H8 pos34=newLine82, pos36=newLine83
    //   H9 pos38=newLine94, pos41=newLine95, pos42=newLine96, pos43=newLine97
    //   H10 pos45=newLine108, pos46=newLine109, pos47=newLine110
    expect(map.positionByNewLine).toEqual({
      "1": 1,
      "2": 3,
      "3": 4,
      "4": 5,
      "11": 7,
      "12": 8,
      "13": 9,
      "22": 11,
      "23": 14,
      "42": 20,
      "43": 21,
      "54": 23,
      "55": 24,
      "56": 26,
      "57": 27,
      "58": 28,
      "69": 30,
      "70": 31,
      "71": 32,
      "82": 34,
      "83": 36,
      "94": 38,
      "95": 41,
      "96": 42,
      "97": 43,
      "108": 45,
      "109": 46,
      "110": 47,
    });
  });

  it("positionByOldLine matches the fixture's hand-tallied position for every hunk", () => {
    // Hand-computed the same way, for the OLD side — every LEFT-commentable line:
    //   H1 pos1=oldLine1, pos2=oldLine2, pos5=oldLine3
    //   H2 pos7=oldLine10, pos9=oldLine11
    //   H3 pos11=oldLine20, pos12=oldLine21, pos13=oldLine22, pos14=oldLine23
    //   H4 pos16=oldLine34, pos17=oldLine35, pos18=oldLine36
    //   H5 (no old-side entries — addition-only)
    //   H6 pos23=oldLine55, pos24=oldLine56, pos25=oldLine57, pos27=oldLine58, pos28=oldLine59
    //   H7 pos30=oldLine70, pos32=oldLine71
    //   H8 pos34=oldLine82, pos35=oldLine83, pos36=oldLine84
    //   H9 pos38=oldLine95, pos39=oldLine96, pos40=oldLine97, pos43=oldLine98
    //   H10 pos45=oldLine109, pos47=oldLine110
    expect(map.positionByOldLine).toEqual({
      "1": 1,
      "2": 2,
      "3": 5,
      "10": 7,
      "11": 9,
      "20": 11,
      "21": 12,
      "22": 13,
      "23": 14,
      "34": 16,
      "35": 17,
      "36": 18,
      "55": 23,
      "56": 24,
      "57": 25,
      "58": 27,
      "59": 28,
      "70": 30,
      "71": 32,
      "82": 34,
      "83": 35,
      "84": 36,
      "95": 38,
      "96": 39,
      "97": 40,
      "98": 43,
      "109": 45,
      "110": 47,
    });
  });
});

describe("buildDiffPositionMap — multi-hunk position carry-over", () => {
  it("a line in hunk 3 has the exact hand-computed position, not merely a number greater than hunk 2's", () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      " a",
      "@@ -10,1 +10,1 @@",
      " b",
      "@@ -20,1 +20,1 @@",
      " c",
    ].join("\n");

    // Hand-computed: header1 consumes none. " a"=pos1. header2 consumes pos2 (silent).
    // " b"=pos3. header3 consumes pos4 (silent). " c"=pos5.
    const map = buildDiffPositionMap(parsePatch(patch));

    expect(map.positionByNewLine["1"]).toBe(1);
    expect(map.positionByNewLine["10"]).toBe(3);
    expect(map.positionByNewLine["20"]).toBe(5);
  });
});

describe("buildDiffPositionMap — adjacent hunks", () => {
  it("hunk N+1 starting exactly one line after hunk N ends: both ranges present, not merged, no line double-counted", () => {
    const patch = ["@@ -1,2 +1,2 @@", " a", " b", "@@ -3,1 +3,2 @@", " c", "+d"].join("\n");

    // hunk1 new range: newStart=1, newLines=2 -> newEnd=2. hunk2 newStart=3 = 2+1,
    // immediately adjacent, not overlapping.
    const map = buildDiffPositionMap(parsePatch(patch));

    expect(map.hunks).toEqual([
      { oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 },
      { oldStart: 3, oldEnd: 3, newStart: 3, newEnd: 4 },
    ]);
    // Hand-computed: " a"=newLine1, " b"=newLine2, " c"=newLine3 (context, LEFT+RIGHT),
    // "+d"=newLine4 (RIGHT only). Every line present exactly once, none merged.
    expect(map.commentableRight).toEqual([1, 2, 3, 4]);
    expect(map.commentableLeft).toEqual([1, 2, 3]);
  });
});

describe("buildDiffPositionMap — deletion-only hunk", () => {
  it("@@ -10,3 +9,0 @@ produces 3 LEFT-commentable lines, 0 RIGHT-commentable lines, and newEnd < newStart", () => {
    const patch = ["@@ -10,3 +9,0 @@", "-x", "-y", "-z"].join("\n");

    const map = buildDiffPositionMap(parsePatch(patch));

    // Hand-computed: oldStart=10, oldLines=3 -> oldEnd=12. newLines=0 -> newEnd=newStart-1=8.
    expect(map.hunks).toEqual([{ oldStart: 10, oldEnd: 12, newStart: 9, newEnd: 8 }]);
    expect(map.hunks[0]!.newEnd).toBeLessThan(map.hunks[0]!.newStart);
    expect(map.commentableLeft).toEqual([10, 11, 12]);
    expect(map.commentableRight).toEqual([]);
  });
});

describe("buildDiffPositionMap — addition-only hunk", () => {
  it("@@ -10,0 +11,3 @@ produces 3 RIGHT-commentable lines, 0 LEFT-commentable lines, and oldEnd < oldStart", () => {
    const patch = ["@@ -10,0 +11,3 @@", "+x", "+y", "+z"].join("\n");

    const map = buildDiffPositionMap(parsePatch(patch));

    // Hand-computed: newStart=11, newLines=3 -> newEnd=13. oldLines=0 -> oldEnd=oldStart-1=9.
    expect(map.hunks).toEqual([{ oldStart: 10, oldEnd: 9, newStart: 11, newEnd: 13 }]);
    expect(map.hunks[0]!.oldEnd).toBeLessThan(map.hunks[0]!.oldStart);
    expect(map.commentableRight).toEqual([11, 12, 13]);
    expect(map.commentableLeft).toEqual([]);
  });
});

describe("buildDiffPositionMap — context-only region (the commonly missed case)", () => {
  it("every context line around a single change is commentable on BOTH sides", () => {
    const patch = [
      "@@ -1,5 +1,5 @@",
      " ctx1",
      " ctx2",
      "-old",
      "+new",
      " ctx3",
    ].join("\n");

    const map = buildDiffPositionMap(parsePatch(patch));

    // Hand-computed old/new numbering: ctx1 old1/new1, ctx2 old2/new2, old(-) old3,
    // new(+) new3, ctx3 old4/new4.
    expect(map.commentableLeft).toEqual([1, 2, 3, 4]);
    expect(map.commentableRight).toEqual([1, 2, 3, 4]);
    // Explicitly: every context line (1, 2, 4 on the old side; 1, 2, 4 on the new side)
    // is in BOTH arrays, not just one.
    for (const line of [1, 2, 4]) {
      expect(map.commentableLeft).toContain(line);
      expect(map.commentableRight).toContain(line);
    }
  });
});

describe("buildDiffPositionMap — no newline at end of file", () => {
  it("the \\ marker contributes no map entry, and a later hunk's positions still account for it", () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "\\ No newline at end of file",
      "@@ -5,1 +5,1 @@",
      " ctx",
    ].join("\n");

    const map = buildDiffPositionMap(parsePatch(patch));

    // Hand-computed positions: "-old"=pos1 (oldLine1), "+new"=pos2 (newLine1), the "\"
    // marker=pos3 (no map entry), second header consumes pos4 (silent), " ctx"=pos5
    // (oldLine5, newLine5). If the "\" marker did not consume a position, " ctx" would
    // wrongly land on position 4 instead of 5.
    expect(map.commentableLeft).toEqual([1, 5]);
    expect(map.commentableRight).toEqual([1, 5]);
    expect(map.positionByOldLine["5"]).toBe(5);
    expect(map.positionByNewLine["5"]).toBe(5);
    // The no-newline marker's own line (oldLine null, newLine null) never appears as a key.
    expect(Object.keys(map.positionByOldLine)).not.toContain("null");
    expect(Object.keys(map.positionByNewLine)).not.toContain("null");
  });
});

describe("buildDiffPositionMap — CRLF", () => {
  it("produces an identical map to the \\n version", () => {
    const lf = readFixture("ten-hunk.patch");
    const crlf = lf.split("\n").join("\r\n");

    const mapLf = buildDiffPositionMap(parsePatch(lf));
    const mapCrlf = buildDiffPositionMap(parsePatch(crlf));

    expect(mapCrlf).toEqual(mapLf);
  });
});

describe("buildDiffPositionMap — unicode / multibyte", () => {
  it("maps identically to its ASCII structural equivalent — line numbers, not byte offsets", () => {
    const ascii = ["@@ -1,2 +1,2 @@", "-hello", "+goodbye", " done"].join("\n");
    const unicode = ["@@ -1,2 +1,2 @@", '-console.log("héllo");', '+console.log("こんにちは 🚀");', " // done"].join(
      "\n",
    );

    const mapAscii = buildDiffPositionMap(parsePatch(ascii));
    const mapUnicode = buildDiffPositionMap(parsePatch(unicode));

    // Hand-computed: both patches have the identical structural shape (-, +, context),
    // so the position/line-number scaffolding must be byte-for-byte identical even
    // though the text differs — only `text` (not part of DiffPositionMap) differs.
    expect(mapUnicode.hunks).toEqual(mapAscii.hunks);
    expect(mapUnicode.commentableLeft).toEqual(mapAscii.commentableLeft);
    expect(mapUnicode.commentableRight).toEqual(mapAscii.commentableRight);
    expect(mapUnicode.positionByNewLine).toEqual(mapAscii.positionByNewLine);
    expect(mapUnicode.positionByOldLine).toEqual(mapAscii.positionByOldLine);
  });
});

describe("buildDiffPositionMap — empty / absent patch", () => {
  it("null, undefined, empty string, and a string with no @@ all produce an empty map, never throwing", () => {
    for (const input of [null, undefined, "", "just some text\nno headers here"]) {
      const map = buildDiffPositionMap(parsePatch(input));
      expect(map).toEqual({
        commentableRight: [],
        commentableLeft: [],
        positionByNewLine: {},
        positionByOldLine: {},
        hunks: [],
        empty: true,
      });
    }
  });
});

describe("buildDiffPositionMap — binary file (no @@ at all)", () => {
  it("is indistinguishable from the empty/absent case", () => {
    const map = buildDiffPositionMap(parsePatch("Binary files a/img.png and b/img.png differ\n"));
    expect(map.empty).toBe(true);
    expect(map.hunks).toEqual([]);
  });
});

describe("isCommentable", () => {
  const patch = ["@@ -1,3 +1,3 @@", " a", "-b", "+b2", " c", "@@ -10,1 +10,1 @@", " z"].join("\n");
  const map = buildDiffPositionMap(parsePatch(patch));

  it("true for an added line on RIGHT", () => {
    // "+b2" -> newLine 2 (a=1, b/b2=2).
    expect(isCommentable(map, 2, "RIGHT")).toBe(true);
  });

  it("true for a deleted line on LEFT", () => {
    // "-b" -> oldLine 2.
    expect(isCommentable(map, 2, "LEFT")).toBe(true);
  });

  it("true for a context line on BOTH sides", () => {
    // " a" -> oldLine 1 / newLine 1.
    expect(isCommentable(map, 1, "LEFT")).toBe(true);
    expect(isCommentable(map, 1, "RIGHT")).toBe(true);
  });

  it("false for a line one past a hunk's end", () => {
    // hunk1 new range is 1-3 (a=1, b2=2, c=3); line 4 is one past it.
    expect(isCommentable(map, 4, "RIGHT")).toBe(false);
  });

  it("false for a line before a hunk's start", () => {
    // hunk2 old range starts at 10; line 9 is one before it.
    expect(isCommentable(map, 9, "LEFT")).toBe(false);
  });

  it("false for a line in the gap between two hunks", () => {
    // hunk1 ends at old/new line 3, hunk2 starts at old/new line 10 -> lines 4-9 are gap.
    expect(isCommentable(map, 6, "LEFT")).toBe(false);
    expect(isCommentable(map, 6, "RIGHT")).toBe(false);
  });
});

describe("snapToCommentable", () => {
  const patch = ["@@ -10,3 +10,3 @@", " a", " b", " c"].join("\n");
  const map = buildDiffPositionMap(parsePatch(patch));
  // commentableRight/Left both == [10, 11, 12] (all context).

  it("snaps within +/-3 to the nearest commentable line", () => {
    // line 13 is distance 1 from 12 (the nearest) -> snaps to 12.
    expect(snapToCommentable(map, 13, "RIGHT")).toBe(12);
    // line 8 is distance 2 from 10 (the nearest) -> snaps to 10.
    expect(snapToCommentable(map, 8, "LEFT")).toBe(10);
  });

  it("returns null at distance 4 (just past the default maxDistance of 3)", () => {
    // line 16: nearest commentable is 12, distance 4 -> out of range.
    expect(snapToCommentable(map, 16, "RIGHT")).toBeNull();
    // line 6: nearest commentable is 10, distance 4 -> out of range.
    expect(snapToCommentable(map, 6, "LEFT")).toBeNull();
  });

  it("ties break to the lower line number", () => {
    const twoHunkPatch = ["@@ -1,1 +1,1 @@", " x", "@@ -7,1 +7,1 @@", " y"].join("\n");
    const twoHunkMap = buildDiffPositionMap(parsePatch(twoHunkPatch));
    // commentableRight == [1, 7]. Line 4 is distance 3 from both 1 and 7 -> tie, must
    // break toward the lower line number, 1.
    expect(snapToCommentable(twoHunkMap, 4, "RIGHT")).toBe(1);
  });

  it("snapping across a hunk gap does not jump to a farther line in a different hunk when a nearer one exists in the same hunk", () => {
    const twoHunkPatch = ["@@ -1,2 +1,2 @@", " a", " b", "@@ -20,1 +20,1 @@", " z"].join("\n");
    const twoHunkMap = buildDiffPositionMap(parsePatch(twoHunkPatch));
    // commentableRight == [1, 2, 20]. Line 3 is distance 1 from 2 (same hunk) and
    // distance 17 from 20 (the other hunk) -> must pick 2, never 20.
    expect(snapToCommentable(twoHunkMap, 3, "RIGHT")).toBe(2);
  });

  it("a custom maxDistance is honored", () => {
    const singleLine = buildDiffPositionMap(parsePatch(["@@ -10,1 +10,1 @@", " a"].join("\n")));
    // commentableRight == [10]. Distance 5 is out of range for the default (3) but
    // within range for an explicit maxDistance of 5.
    expect(snapToCommentable(singleLine, 15, "RIGHT", 3)).toBeNull();
    expect(snapToCommentable(singleLine, 15, "RIGHT", 5)).toBe(10);
  });
});

describe("positionFor", () => {
  const patch = ["@@ -10,2 +10,2 @@", " a", "-b"].join("\n");
  const map = buildDiffPositionMap(parsePatch(patch));

  it("returns the hand-verified position for a known line", () => {
    // Header consumes none (first). " a"=pos1 (oldLine10/newLine10). "-b"=pos2 (oldLine11).
    expect(positionFor(map, 10, "RIGHT")).toBe(1);
    expect(positionFor(map, 10, "LEFT")).toBe(1);
    expect(positionFor(map, 11, "LEFT")).toBe(2);
  });

  it("returns null for an uncommentable line", () => {
    expect(positionFor(map, 11, "RIGHT")).toBeNull(); // "-b" has no new line
    expect(positionFor(map, 999, "LEFT")).toBeNull();
  });
});

describe("JSON round-trip — the Set/Map trap", () => {
  it("JSON.parse(JSON.stringify(map)) deep-equals the original map", () => {
    const patch = readFixture("ten-hunk.patch");
    const map = buildDiffPositionMap(parsePatch(patch));

    const roundTripped = JSON.parse(JSON.stringify(map)) as DiffPositionMap;

    expect(roundTripped).toEqual(map);
  });

  it("no value anywhere in the map is a Set, a Map, or a Date", () => {
    const map = buildDiffPositionMap(parsePatch(readFixture("ten-hunk.patch")));

    const seen = new Set<unknown>();
    function assertNoBannedTypes(value: unknown): void {
      if (value === null || typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);
      expect(value).not.toBeInstanceOf(Set);
      expect(value).not.toBeInstanceOf(Map);
      expect(value).not.toBeInstanceOf(Date);
      for (const child of Object.values(value as Record<string, unknown>)) {
        assertNoBannedTypes(child);
      }
    }
    assertNoBannedTypes(map);
  });

  it("the empty map also round-trips cleanly", () => {
    const map = buildDiffPositionMap(parsePatch(null));
    expect(JSON.parse(JSON.stringify(map))).toEqual(map);
  });
});
