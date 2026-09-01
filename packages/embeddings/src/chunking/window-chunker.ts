import { WINDOW_CHUNK_LINES, WINDOW_OVERLAP_LINES } from "@repo/shared";
import {
  computeContentHash,
  formatChunkHeader,
  type CodeChunkDraft,
} from "./chunk.types.js";
import { estimateTokens } from "./token-estimator.js";

/**
 * Phase 05 prompt 3, sub-task 3.4: the line-based fallback chunker, used for any file
 * with no trustworthy AST — `parseState !== "OK"` (a malformed source file), or
 * `parseState === "OK"` with zero symbols (this package's own router, `chunkFile` in
 * index.ts, decides exactly which files route here; see that module's own comment for
 * the predicate and why). `@repo/shared`'s own `PARSE_STATES` comment: a `FAILED` file
 * "stays indexed for Phase 05's text/semantic search" — this module is what makes that
 * true, and it is also what makes a `.md`/`.json`/`.yml` file (an entirely different
 * language the parsing layer never attempts) still semantically searchable.
 *
 * Every window chunk carries no symbol/import data at all (`symbols: []`,
 * `imports: []`, `anchorSymbolName: null`) — this module works from raw text and a file
 * path only, never a parsed structure, so there is nothing to denormalize.
 */

/**
 * Below this many remaining lines, the final window is folded into the previous one
 * rather than becoming its own chunk — a lone 3-line trailing fragment is close to
 * useless as a retrieval unit and not worth a separate embedding call. Chosen as a
 * quarter of `WINDOW_CHUNK_LINES` (15 lines): small enough that a genuinely
 * differently-themed trailing section (say, 20+ lines) still gets its own window, large
 * enough to catch the "a few leftover lines" case the orphan rule exists for.
 */
const ORPHAN_THRESHOLD_LINES = Math.floor(WINDOW_CHUNK_LINES / 4);

function buildWindowChunk(
  filePath: string,
  startLine: number,
  endLine: number,
  lines: readonly string[],
): CodeChunkDraft {
  const body = lines.slice(startLine - 1, endLine).join("\n");
  const header = formatChunkHeader({ filePath, symbolName: null, startLine, endLine });
  const content = `${header}\n${body}`;
  return {
    chunkKind: "WINDOW",
    startLine,
    endLine,
    content,
    contentHash: computeContentHash(content),
    tokenCount: estimateTokens(content),
    symbols: [],
    imports: [],
    anchorSymbolName: null,
  };
}

/**
 * `WINDOW_CHUNK_LINES` (60) windows with `WINDOW_OVERLAP_LINES` (10) overlap.
 *
 * - An empty or whitespace-only file (`source.trim().length === 0`) emits **zero**
 *   chunks — embedding an empty string costs money and returns noise (§3.4's own
 *   instruction).
 * - A file at or under one window's worth of lines emits exactly one chunk covering the
 *   whole file — this falls out of the general loop below with no special case needed:
 *   the first window's `end` is already clamped to `total`, and the orphan-fold check
 *   (`remainder === 0`) never fires.
 * - Otherwise, windows advance by `WINDOW_CHUNK_LINES - WINDOW_OVERLAP_LINES` lines each
 *   step; whenever the *next* window's remainder would be a below-threshold orphan
 *   (see {@link ORPHAN_THRESHOLD_LINES}), the current window's `endLine` is extended to
 *   the end of the file instead, folding the orphan tail into it.
 */
export function chunkFileWithWindows(source: string, filePath: string): CodeChunkDraft[] {
  if (source.trim().length === 0) return [];

  const lines = source.split("\n");
  const total = lines.length;

  const chunks: CodeChunkDraft[] = [];
  let start = 1;

  for (;;) {
    let end = Math.min(start + WINDOW_CHUNK_LINES - 1, total);
    const remainder = total - end;
    if (remainder > 0 && remainder < ORPHAN_THRESHOLD_LINES) {
      end = total;
    }

    chunks.push(buildWindowChunk(filePath, start, end, lines));
    if (end >= total) break;
    start = end - WINDOW_OVERLAP_LINES + 1;
  }

  return chunks;
}
