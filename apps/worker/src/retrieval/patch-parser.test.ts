import { describe, expect, it } from "vitest";
import { countChangedLines, parsePatch } from "./patch-parser.js";

/**
 * Sub-task 2.6. Every fixture below is hand-written and hand-verified — each `it` states
 * the expected `oldLine`/`newLine`/`position` values worked out by hand in a comment
 * before asserting them, per the sub-task's own instruction. This suite is what
 * Prompt 3's (higher-stakes) diff-position-map suite is built on top of, so the position
 * rule in particular is checked from several independent angles rather than once.
 */

describe("parsePatch — single simple hunk", () => {
  it("assigns oldLine/newLine/position by hand for +, -, and context lines", () => {
    const patch = ["@@ -1,3 +1,3 @@", " line1", "-line2", "+line2 modified", " line3"].join(
      "\n",
    );

    // Hand-computed: header consumes no position (it's the first). Then, in order:
    //   " line1"           -> position 1, oldLine 1, newLine 1
    //   "-line2"           -> position 2, oldLine 2, newLine null
    //   "+line2 modified"  -> position 3, oldLine null, newLine 2
    //   " line3"           -> position 4, oldLine 3, newLine 3
    const result = parsePatch(patch);

    expect(result.empty).toBe(false);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.lines).toEqual([
      { type: " ", oldLine: 1, newLine: 1, text: "line1", position: 1 },
      { type: "-", oldLine: 2, newLine: null, text: "line2", position: 2 },
      { type: "+", oldLine: null, newLine: 2, text: "line2 modified", position: 3 },
      { type: " ", oldLine: 3, newLine: 3, text: "line3", position: 4 },
    ]);
  });
});

describe("parsePatch — multi-hunk position carry-over", () => {
  it("carries position across three hunks, each intervening @@ header consuming exactly one position", () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      " a",
      "@@ -10,1 +10,1 @@",
      " b",
      "@@ -20,1 +20,1 @@",
      " c",
    ].join("\n");

    // Hand-computed: first header consumes no position.
    //   " a" -> position 1
    //   second "@@" header -> consumes position 2 (silent, no PatchLine)
    //   " b" -> position 3
    //   third "@@" header -> consumes position 4 (silent, no PatchLine)
    //   " c" -> position 5
    // This is the exact off-by-N bug this test exists to catch: without the header
    // consuming a position, " b" and " c" would land on 2 and 3 instead of 3 and 5.
    const result = parsePatch(patch);

    expect(result.hunks).toHaveLength(3);
    expect(result.hunks[0]?.lines[0]).toMatchObject({ text: "a", position: 1 });
    expect(result.hunks[1]?.lines[0]).toMatchObject({ text: "b", position: 3 });
    expect(result.hunks[2]?.lines[0]).toMatchObject({ text: "c", position: 5 });
  });
});

describe("parsePatch — adjacent hunks", () => {
  it("does not merge or double-count hunks whose newStart is exactly the prior hunk's last new line + 1", () => {
    const patch = ["@@ -1,2 +1,2 @@", " a", " b", "@@ -3,1 +3,1 @@", "-c", "+c2"].join("\n");

    // hunk1: newStart=1, newLines=2 -> last new line = 2. hunk2.newStart = 3 = 2 + 1.
    // Hand-computed positions: " a"=1, " b"=2, header2 consumes 3 (silent), "-c"=4, "+c2"=5.
    const result = parsePatch(patch);

    expect(result.hunks).toHaveLength(2);
    const [hunk1, hunk2] = result.hunks;
    expect(hunk2?.newStart).toBe((hunk1?.newStart ?? 0) + (hunk1?.newLines ?? 0));
    expect(hunk1?.lines).toHaveLength(2);
    expect(hunk2?.lines).toEqual([
      { type: "-", oldLine: 3, newLine: null, text: "c", position: 4 },
      { type: "+", oldLine: null, newLine: 3, text: "c2", position: 5 },
    ]);
  });
});

describe("parsePatch — addition-only hunk", () => {
  it("@@ -10,0 +11,3 @@ has oldLines: 0 and every emitted line has oldLine: null", () => {
    const patch = ["@@ -10,0 +11,3 @@", "+x", "+y", "+z"].join("\n");

    const result = parsePatch(patch);
    const hunk = result.hunks[0];

    expect(hunk).toMatchObject({ oldStart: 10, oldLines: 0, newStart: 11, newLines: 3 });
    expect(hunk?.lines.every((line) => line.oldLine === null)).toBe(true);
    expect(hunk?.lines.map((line) => line.newLine)).toEqual([11, 12, 13]);
  });
});

describe("parsePatch — deletion-only hunk", () => {
  it("@@ -10,3 +9,0 @@ has newLines: 0 and every emitted line has newLine: null", () => {
    const patch = ["@@ -10,3 +9,0 @@", "-x", "-y", "-z"].join("\n");

    const result = parsePatch(patch);
    const hunk = result.hunks[0];

    expect(hunk).toMatchObject({ oldStart: 10, oldLines: 3, newStart: 9, newLines: 0 });
    expect(hunk?.lines.every((line) => line.newLine === null)).toBe(true);
    expect(hunk?.lines.map((line) => line.oldLine)).toEqual([10, 11, 12]);
  });
});

describe("parsePatch — shorthand counts", () => {
  it("@@ -1 +1 @@ parses as oldLines: 1, newLines: 1", () => {
    const patch = ["@@ -1 +1 @@", " x"].join("\n");

    const result = parsePatch(patch);

    expect(result.hunks[0]).toMatchObject({
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
    });
  });
});

describe("parsePatch — section heading", () => {
  it("keeps the section heading verbatim in header, ignored for counting", () => {
    const patch = ["@@ -1,5 +1,5 @@ function login(user) {", " line"].join("\n");

    const result = parsePatch(patch);

    expect(result.hunks[0]?.header).toBe("@@ -1,5 +1,5 @@ function login(user) {");
    expect(result.hunks[0]).toMatchObject({ oldLines: 5, newLines: 5 });
  });
});

describe("parsePatch — no newline at end of file", () => {
  it("the \\ marker line advances position but neither line counter, and has both line numbers null", () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");

    // Hand-computed: "-old"=position 1 (oldLine 1), "+new"=position 2 (newLine 1),
    // the "\" marker=position 3, oldLine null, newLine null.
    const result = parsePatch(patch);

    expect(result.hunks[0]?.lines).toEqual([
      { type: "-", oldLine: 1, newLine: null, text: "old", position: 1 },
      { type: "+", oldLine: null, newLine: 1, text: "new", position: 2 },
      { type: "\\", oldLine: null, newLine: null, text: " No newline at end of file", position: 3 },
    ]);
  });
});

describe("parsePatch — CRLF patch", () => {
  it("produces identical line numbers and positions to the \\n version", () => {
    const lf = ["@@ -1,3 +1,3 @@", " line1", "-line2", "+line2 modified", " line3"].join(
      "\n",
    );
    const crlf = lf.split("\n").join("\r\n");

    expect(parsePatch(crlf)).toEqual(parsePatch(lf));
    // And no line's text carries a stray \r.
    for (const hunk of parsePatch(crlf).hunks) {
      for (const line of hunk.lines) {
        expect(line.text.endsWith("\r")).toBe(false);
      }
    }
  });
});

describe("parsePatch — unicode / multibyte", () => {
  it("leaves line numbering unaffected and round-trips text exactly", () => {
    const patch = [
      "@@ -1,2 +1,2 @@",
      '-console.log("héllo");',
      '+console.log("こんにちは 🚀");',
      " // done",
    ].join("\n");

    const result = parsePatch(patch);

    expect(result.hunks[0]?.lines).toEqual([
      { type: "-", oldLine: 1, newLine: null, text: 'console.log("héllo");', position: 1 },
      {
        type: "+",
        oldLine: null,
        newLine: 1,
        text: 'console.log("こんにちは 🚀");',
        position: 2,
      },
      { type: " ", oldLine: 2, newLine: 2, text: "// done", position: 3 },
    ]);
  });
});

describe("parsePatch — empty / absent patch", () => {
  it("null, undefined, empty string, and a string with no @@ all return { hunks: [], empty: true }, never throwing", () => {
    expect(parsePatch(null)).toEqual({ hunks: [], empty: true });
    expect(parsePatch(undefined)).toEqual({ hunks: [], empty: true });
    expect(parsePatch("")).toEqual({ hunks: [], empty: true });
    expect(parsePatch("just some text\nno headers here")).toEqual({
      hunks: [],
      empty: true,
    });
  });
});

describe("parsePatch — malformed hunk header", () => {
  it("drops only the malformed hunk; valid hunks before and after it still parse", () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      " a",
      "@@ garbage @@",
      "+should not appear",
      "@@ -5,1 +5,1 @@",
      " b",
    ].join("\n");

    // Hand-computed: " a"=position 1. The malformed header consumes position 2 (silent);
    // its body line "+should not appear" consumes position 3 but is discarded (no hunk
    // is open). The next valid header consumes position 4 (silent); " b"=position 5.
    const result = parsePatch(patch);

    expect(result.hunks).toHaveLength(2);
    expect(result.hunks[0]?.lines).toEqual([
      { type: " ", oldLine: 1, newLine: 1, text: "a", position: 1 },
    ]);
    expect(result.hunks[1]).toMatchObject({ header: "@@ -5,1 +5,1 @@" });
    expect(result.hunks[1]?.lines).toEqual([
      { type: " ", oldLine: 5, newLine: 5, text: "b", position: 5 },
    ]);
    const allText = result.hunks.flatMap((h) => h.lines.map((l) => l.text));
    expect(allText).not.toContain("should not appear");
  });
});

describe("parsePatch — a content line beginning with @@", () => {
  it("treats a context line whose content starts with @@ as content, not a header", () => {
    const patch = [
      "@@ -1,2 +1,2 @@",
      " @@ this looks like a header but is content",
      "-old",
      "+new",
    ].join("\n");

    const result = parsePatch(patch);

    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.lines[0]).toEqual({
      type: " ",
      oldLine: 1,
      newLine: 1,
      text: "@@ this looks like a header but is content",
      position: 1,
    });
  });
});

describe("countChangedLines", () => {
  it("counts only +/- lines across a multi-hunk patch", () => {
    const patch = [
      "@@ -1,2 +1,2 @@",
      "-old1",
      "+new1",
      " ctx",
      "@@ -10,1 +10,2 @@",
      " ctx2",
      "+added1",
      "+added2",
    ].join("\n");

    const result = parsePatch(patch);

    expect(countChangedLines(result)).toBe(4);
  });
});
