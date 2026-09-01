/**
 * The unified-diff patch parser — `plan.md` §44's `retrieval/patch-parser.ts`.
 *
 * **Built once, shared everywhere.** `plan.md` §15.3: "This same structure feeds the
 * diff-position map for comment publishing — build it once, store it, reuse it. Do not
 * use two different patch parsers in one system." `diff-position-map.ts` (Prompt 3)
 * consumes this module's {@link ParsedPatch} output directly and must never re-parse a
 * patch string itself. Phase 08's Context Engine extends this parser's *usage*
 * (hunk-based context extraction around a changed line) without recreating any of the
 * parsing logic below. Phase 13's comment publisher is the third and last consumer, via
 * the position map, never via this file directly.
 *
 * **Pure. No I/O, no Prisma, no logger, no `Date.now()`.** Every export here is a
 * function of its input alone, which is what makes the boundary cases in
 * `patch-parser.test.ts` exhaustively testable without a database or a mock clock.
 */

export type PatchLineType = "+" | "-" | " " | "\\";

export interface PatchLine {
  type: PatchLineType;
  /** 1-based line number in the OLD file. `null` on an added line. */
  oldLine: number | null;
  /** 1-based line number in the NEW file. `null` on a deleted line. */
  newLine: number | null;
  /** The line's content WITHOUT its leading +/-/space/backslash marker. */
  text: string;
  /**
   * GitHub's legacy `position` value for this line: the 1-based offset counting down
   * from the FIRST `@@` header in this file's patch. The line immediately below that
   * first `@@` is position 1, the next is 2, and so on — counting through blank lines,
   * context lines, and every subsequent `@@` header (which itself consumes one position
   * number even though it never gets a `PatchLine`) until the patch ends. See
   * {@link parsePatch}'s own comment for the exact bookkeeping.
   */
  position: number;
}

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The raw `@@ ... @@` line, section heading included. */
  header: string;
  lines: PatchLine[];
}

export interface ParsedPatch {
  hunks: PatchHunk[];
  /** True when the input was null/undefined/empty, or contained no `@@` header at all —
   * a binary file, a pure rename, or a patch GitHub omitted. Never an error. */
  empty: boolean;
}

/** `@@ -oldStart[,oldLines] +newStart[,newLines] @@ optional section heading`. Both
 * `,count` groups are optional (an omitted count means 1); a count of `0` is legal and
 * left exactly as git wrote it — never "corrected". */
const HUNK_HEADER_RE =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/;

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Parses a unified-diff patch body (GitHub's `patch` field shape, or
 * `splitDiffByFile`'s per-file output from `@repo/github`) into structured hunks.
 *
 * The `position` rule, precisely: the counter starts at `0` and is not incremented for
 * the first `@@` header encountered. Every line after that — `+`, `-`, context, a
 * `\ No newline at end of file` marker, and every LATER `@@` header — increments the
 * counter by exactly one before that line's own `position` (if it gets one) is read.
 * A later `@@` header therefore silently consumes a position number with no `PatchLine`
 * ever emitted for it; getting this wrong shifts every position after hunk 1 by one per
 * hunk, and comments land on the wrong line with no visible error.
 *
 * A malformed `@@ ... @@` line (fails the shape above) drops just that hunk — its header
 * and every line until the next valid `@@` or end of patch — rather than throwing;
 * hunks before and after it still parse normally. Detection is "starts with `@@`", not
 * "matches the full pattern", specifically so a malformed header is never misread as an
 * ordinary content line of whatever hunk preceded it.
 */
export function parsePatch(patch: string | null | undefined): ParsedPatch {
  if (!patch) return { hunks: [], empty: true };

  const rawLines = patch.split("\n");
  // A trailing "\n" produces one spurious empty split element; drop only that artifact,
  // never a real (possibly genuinely empty) content line.
  if (patch.endsWith("\n")) rawLines.pop();
  const lines = rawLines.map(stripCr);

  const hunks: PatchHunk[] = [];
  let currentHunk: PatchHunk | null = null;
  let oldLineNum = 0;
  let newLineNum = 0;
  let position = 0;
  let sawFirstHeader = false;

  for (const rawLine of lines) {
    if (rawLine.startsWith("@@")) {
      if (sawFirstHeader) position += 1;
      else sawFirstHeader = true;

      const match = HUNK_HEADER_RE.exec(rawLine);
      if (!match) {
        // Malformed header: drop this hunk entirely. Subsequent lines fall into the
        // `!currentHunk` branch below until the next valid header restarts one.
        currentHunk = null;
        continue;
      }

      const oldStart = Number(match[1]);
      const oldLines = match[2] !== undefined ? Number(match[2]) : 1;
      const newStart = Number(match[3]);
      const newLines = match[4] !== undefined ? Number(match[4]) : 1;

      currentHunk = { oldStart, oldLines, newStart, newLines, header: rawLine, lines: [] };
      hunks.push(currentHunk);
      oldLineNum = oldStart;
      newLineNum = newStart;
      continue;
    }

    if (!sawFirstHeader) continue; // content before any header — nothing to attribute it to

    position += 1;

    if (!currentHunk) continue; // inside a dropped (malformed-header) hunk — discard the line

    const marker = rawLine.length === 0 ? " " : rawLine[0];
    const text = rawLine.length === 0 ? "" : rawLine.slice(1);

    if (marker === "\\") {
      currentHunk.lines.push({ type: "\\", oldLine: null, newLine: null, text, position });
      continue;
    }
    if (marker === "+") {
      currentHunk.lines.push({ type: "+", oldLine: null, newLine: newLineNum, text, position });
      newLineNum += 1;
      continue;
    }
    if (marker === "-") {
      currentHunk.lines.push({ type: "-", oldLine: oldLineNum, newLine: null, text, position });
      oldLineNum += 1;
      continue;
    }
    // Context (" "), and any other unrecognized marker treated defensively as context —
    // an oversized diff must never crash classification over one strange byte.
    currentHunk.lines.push({ type: " ", oldLine: oldLineNum, newLine: newLineNum, text, position });
    oldLineNum += 1;
    newLineNum += 1;
  }

  return { hunks, empty: hunks.length === 0 };
}

/** Total changed (`+`/`-`) lines across all hunks — the `plan.md` §16.4 oversized-file
 * signal (`OVERSIZED_FILE_DIFF_LINES`). */
export function countChangedLines(parsed: ParsedPatch): number {
  let count = 0;
  for (const hunk of parsed.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "+" || line.type === "-") count += 1;
    }
  }
  return count;
}
