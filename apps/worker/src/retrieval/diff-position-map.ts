import type { ParsedPatch } from "./patch-parser.js";

/**
 * The diff position map — `plan.md` §44's `retrieval/diff-position-map.ts`, Prompt 3 of
 * phase-07-pr-ingestion.md. Pure: no I/O, no Prisma, no logger. Consumes {@link ParsedPatch}
 * from `patch-parser.ts` directly and never re-parses a patch string itself — `plan.md`
 * §15.3: "one parser in the system."
 *
 * **JSON-serialisation constraint — do not "improve" this back to a `Set`/`Map`.**
 * {@link DiffPositionMap} is persisted on `PullRequestFile.diffPositionMap` (a Postgres
 * `Json` column) and passes through Inngest step outputs, both of which
 * `JSON.stringify`-serialise their payload. `JSON.stringify(new Set([1, 2, 3]))` and
 * `JSON.stringify(new Map([[1, 2]]))` both produce `"{}"` — an empty object, not an error.
 * Written to Postgres and read back, that empty object means *every line looks
 * uncommentable*, and Phase 13 silently demotes every finding to a file-level comment,
 * weeks from now, with nothing pointing back here. The persisted shape below therefore
 * uses only JSON-native types: arrays and string-keyed plain objects, never `Set`, `Map`,
 * `bigint`, or `Date`. (This module's own internal working state may use a `Set` while
 * building the map — see {@link buildDiffPositionMap} — the constraint is on what gets
 * returned and persisted, not on every local variable along the way.)
 *
 * **Size note.** A 3,000-line patch produces a map with ~3,000 array entries and ~6,000
 * object keys — fine, and exactly what this structure is for. But it is persisted per
 * file, so a future change that starts storing per-line *text* in here (rather than just
 * line numbers and positions) would multiply row sizes across every `PullRequestFile`.
 * This map is structural only, deliberately — line numbers and GitHub `position`
 * integers, nothing else.
 */

export interface DiffPositionMap {
  /** Sorted ascending, deduplicated. Absolute NEW-file line numbers that GitHub will accept
   * an inline comment on with `side: "RIGHT"`. Every added and every context line inside a
   * hunk. An array, not a Set — see this module's header on JSON serialisation. */
  commentableRight: number[];

  /** Sorted ascending, deduplicated. Absolute OLD-file line numbers commentable with
   * `side: "LEFT"` — deleted lines, and context lines (which exist on both sides). */
  commentableLeft: number[];

  /** GitHub's legacy `position` parameter, keyed by absolute NEW-file line. Keys are strings
   * because JSON object keys are always strings — a consumer must do
   * `map.positionByNewLine[String(line)]`. An object, not a Map, for the same reason as above. */
  positionByNewLine: Record<string, number>;

  /** Same, keyed by absolute OLD-file line, for LEFT-side comments. */
  positionByOldLine: Record<string, number>;

  /** Hunk extents, for the ±3-line snapping rule in `plan.md` §23.2 and for Phase 08's
   * hunk-cluster work. Ordered as they appear in the patch. */
  hunks: Array<{ oldStart: number; oldEnd: number; newStart: number; newEnd: number }>;

  /** True when the patch was absent or contained no hunks — a binary file, a pure rename, or
   * a patch GitHub omitted. Every array is empty and every object is `{}`. Distinguishes
   * "genuinely nothing to comment on" from "the map failed to build", which are very different
   * things for Phase 13 to see. */
  empty: boolean;
}

/** Appends `n` to `sorted` only if it is not already the last element — callers push in
 * hunk order, and within one valid (non-overlapping) patch a given absolute line number is
 * only ever emitted once per side, but a pathological/malformed patch (overlapping hunks)
 * must still not violate the "deduplicated" contract on the persisted type. */
function pushDeduped(sorted: number[], n: number): void {
  if (sorted.length === 0 || sorted[sorted.length - 1] !== n) sorted.push(n);
}

/**
 * Builds the persisted diff position map from an already-parsed patch. The commentability
 * rules, exact:
 *
 * - A `+` line: RIGHT-commentable at its `newLine` only (it has no old line).
 * - A `-` line: LEFT-commentable at its `oldLine` only (it has no new line).
 * - A context (`" "`) line inside a hunk: commentable on **both** RIGHT (`newLine`) and
 *   LEFT (`oldLine`) — it is part of the diff, so GitHub accepts a comment on it. Omitting
 *   context lines is the single most common and costly mistake here: findings frequently
 *   point at an unchanged line inside a hunk, and if that line is missing from the map,
 *   Phase 13 demotes a perfectly placeable comment to a file-level one for no reason.
 * - A `\ No newline at end of file` marker line: commentable on **neither** side — it has
 *   no line number on either side. It still consumed a `position` (`patch-parser.ts`
 *   already accounted for that); it contributes no map entry here.
 * - A line outside every hunk: never commentable, by construction — it never appears in
 *   `parsed.hunks` at all. This is the entire 422 condition this map exists to prevent.
 */
export function buildDiffPositionMap(parsed: ParsedPatch): DiffPositionMap {
  if (parsed.empty) {
    return {
      commentableRight: [],
      commentableLeft: [],
      positionByNewLine: {},
      positionByOldLine: {},
      hunks: [],
      empty: true,
    };
  }

  const commentableRight: number[] = [];
  const commentableLeft: number[] = [];
  const positionByNewLine: Record<string, number> = {};
  const positionByOldLine: Record<string, number> = {};
  const hunks: DiffPositionMap["hunks"] = [];

  for (const hunk of parsed.hunks) {
    // A deletion-only hunk (newLines === 0) occupies no new-file lines — newEnd is set
    // below oldStart... below newStart, i.e. newEnd < newStart, which reads correctly as
    // an empty range. Clamping it to newStart instead would claim a line is inside the
    // hunk when it is not, and the snapping rule would then produce a 422. Same logic on
    // the old side for an addition-only hunk (oldLines === 0).
    const newEnd = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart + hunk.newLines - 1;
    const oldEnd = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart + hunk.oldLines - 1;
    hunks.push({ oldStart: hunk.oldStart, oldEnd, newStart: hunk.newStart, newEnd });

    for (const line of hunk.lines) {
      if (line.type === "+") {
        // newLine is never null on a "+" line — patch-parser.ts always sets it.
        const newLine = line.newLine!;
        pushDeduped(commentableRight, newLine);
        positionByNewLine[String(newLine)] = line.position;
      } else if (line.type === "-") {
        const oldLine = line.oldLine!;
        pushDeduped(commentableLeft, oldLine);
        positionByOldLine[String(oldLine)] = line.position;
      } else if (line.type === " ") {
        const newLine = line.newLine!;
        const oldLine = line.oldLine!;
        pushDeduped(commentableRight, newLine);
        positionByNewLine[String(newLine)] = line.position;
        pushDeduped(commentableLeft, oldLine);
        positionByOldLine[String(oldLine)] = line.position;
      }
      // type === "\\" (no newline at EOF): no map entry on either side.
    }
  }

  return { commentableRight, commentableLeft, positionByNewLine, positionByOldLine, hunks, empty: false };
}

/** Returns the index of the first element `>= target` in an ascending-sorted array — the
 * standard binary-search lower bound. Used by {@link isCommentable} and
 * {@link snapToCommentable} so neither degrades to an O(n) scan per call on a large patch. */
function lowerBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sortedIncludes(sorted: readonly number[], value: number): boolean {
  const idx = lowerBound(sorted, value);
  return idx < sorted.length && sorted[idx] === value;
}

/** Whether a comment at (line, side) will be accepted. The single predicate Phase 13 asks. */
export function isCommentable(map: DiffPositionMap, line: number, side: "LEFT" | "RIGHT"): boolean {
  const arr = side === "RIGHT" ? map.commentableRight : map.commentableLeft;
  return sortedIncludes(arr, line);
}

/**
 * `plan.md` §23.2's snapping rule: a line not in any hunk but within ±`maxDistance` (default
 * 3) of a commentable line snaps to the nearest one; ties break toward the LOWER line
 * number, so the behaviour is deterministic and testable rather than dependent on
 * iteration order. Returns null when nothing is within range — the caller then demotes to
 * a file-level comment.
 *
 * Implementation note: candidates are scanned in ascending order starting from the lowest
 * one that could possibly be in range (`lowerBound(line - maxDistance)`), and a candidate
 * only replaces the current best on a *strictly* smaller distance — never on a tie. Because
 * the array is ascending, the first candidate found at any given minimal distance is
 * always the lower one, which is exactly the tie-break this function promises without any
 * extra comparison logic.
 */
export function snapToCommentable(
  map: DiffPositionMap,
  line: number,
  side: "LEFT" | "RIGHT",
  maxDistance = 3,
): number | null {
  const arr = side === "RIGHT" ? map.commentableRight : map.commentableLeft;
  if (arr.length === 0) return null;

  let best: number | null = null;
  let bestDistance = Infinity;
  const startIdx = lowerBound(arr, line - maxDistance);
  for (let i = startIdx; i < arr.length; i += 1) {
    const candidate = arr[i]!;
    if (candidate > line + maxDistance) break;
    const distance = Math.abs(candidate - line);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** The legacy `position` for a line, or null. Kept separate from {@link isCommentable}
 * because the two answers can legitimately differ if GitHub's line-based API and
 * position-based API ever disagree, and a caller should be forced to choose which one it
 * is asking about. */
export function positionFor(map: DiffPositionMap, line: number, side: "LEFT" | "RIGHT"): number | null {
  const table = side === "RIGHT" ? map.positionByNewLine : map.positionByOldLine;
  const value = table[String(line)];
  return value === undefined ? null : value;
}
