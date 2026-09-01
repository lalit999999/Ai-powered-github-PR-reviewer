import type { ChunkKind } from "@repo/shared";
import {
  FILE_HEADER_TARGET_TOKENS_MAX,
  NEIGHBORHOOD_MAX_TOKENS,
  NEIGHBORHOOD_MIN_SYMBOL_TOKENS,
  SPLIT_OVERLAP_RATIO,
  SPLIT_WINDOW_TOKENS,
  SYMBOL_CHUNK_MAX_TOKENS,
} from "@repo/shared";
import {
  computeContentHash,
  formatChunkHeader,
  type CodeChunkDraft,
} from "./chunk.types.js";
import { CHARS_PER_TOKEN_ESTIMATE, estimateTokens } from "./token-estimator.js";

/**
 * Phase 05 prompt 3, sub-task 3.3. Spec §10's chunking rule, implemented against a
 * minimal *structural* input shape rather than an import of apps/worker's own
 * `ParsedFile` — `packages/*` may not depend on `apps/*`. TypeScript's structural typing
 * makes the worker's real `ParsedFile`/`ParsedSymbol`/`ParsedImport` assignable to these
 * types with zero glue code on either side; only the fields this chunker actually reads
 * are declared here.
 */

export interface ChunkableSymbol {
  name: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  signature: string;
  /** The enclosing class/interface's name, for a method — absent for a top-level
   * symbol. "Top-level" is defined as `parentSymbol === undefined`, matching this
   * prompt's own §2.4/3.3 instruction: a method is covered by its enclosing class's own
   * chunk and must never also be emitted as its own top-level chunk. */
  parentSymbol?: string;
}

export interface ChunkableImport {
  specifier: string;
  line: number;
}

/**
 * No `exports` field, deliberately — `ParsedExport` (apps/worker) carries only a name
 * and re-export source, no signature text, and `FILE_HEADER`'s "exported signatures"
 * (§10) come from `ChunkableSymbol.signature` filtered by `isExported` instead, which
 * this chunker already has. `ParsedFile` still structurally satisfies this type despite
 * carrying an `exports` array this chunker never reads.
 */
export interface ChunkableFile {
  filePath: string;
  imports: readonly ChunkableImport[];
  symbols: readonly ChunkableSymbol[];
  parseState: string;
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

function sliceLines(
  sourceLines: readonly string[],
  startLine: number,
  endLine: number,
): string[] {
  // startLine/endLine are 1-based inclusive; sourceLines is 0-based.
  return sourceLines.slice(startLine - 1, endLine);
}

function buildChunk(
  filePath: string,
  chunkKind: ChunkKind,
  symbolName: string | null,
  startLine: number,
  endLine: number,
  bodyText: string,
  symbols: string[],
  imports: string[],
  anchorSymbolName: string | null,
): CodeChunkDraft {
  const header = formatChunkHeader({
    filePath,
    symbolName,
    startLine,
    endLine,
  });
  const content = `${header}\n${bodyText}`;
  return {
    chunkKind,
    startLine,
    endLine,
    content,
    contentHash: computeContentHash(content),
    tokenCount: estimateTokens(content),
    symbols,
    imports,
    anchorSymbolName,
  };
}

// ---------------------------------------------------------------------------
// FILE_HEADER — one synthetic summary chunk per file
// ---------------------------------------------------------------------------

interface LeadingDocblock {
  text: string;
  /** 1-based line the docblock's last line occupies. */
  endLine: number;
}

/**
 * Scans from the top of the file for a leading `/* ... *\/` block comment or a run of
 * consecutive leading `//` line comments, stopping at the first blank or code line.
 * `ParsedFile` (apps/worker) has no field for "the file's own leading docblock" — only
 * per-symbol `docComment` — so this chunker reads it directly out of the raw source it's
 * handed, independent of the parsed symbol/import data.
 */
function extractLeadingDocblock(
  sourceLines: readonly string[],
): LeadingDocblock | null {
  let i = 0;
  while (i < sourceLines.length && (sourceLines[i] ?? "").trim() === "") i++;
  if (i >= sourceLines.length) return null;

  const first = (sourceLines[i] ?? "").trim();
  if (first.startsWith("/*")) {
    const startIdx = i;
    while (i < sourceLines.length && !(sourceLines[i] ?? "").includes("*/"))
      i++;
    if (i >= sourceLines.length) return null; // unterminated block comment — bail, not a real docblock
    const raw = sourceLines.slice(startIdx, i + 1).join("\n");
    const text = raw
      .replace(/^\/\*+/, "")
      .replace(/\*+\/$/, "")
      .split("\n")
      .map((l) => l.trim().replace(/^\*/, "").trim())
      .filter((l) => l.length > 0)
      .join(" ")
      .trim();
    return text.length > 0 ? { text, endLine: i + 1 } : null;
  }

  if (first.startsWith("//")) {
    const startIdx = i;
    while (
      i < sourceLines.length &&
      (sourceLines[i] ?? "").trim().startsWith("//")
    )
      i++;
    const text = sourceLines
      .slice(startIdx, i)
      .map((l) => l.trim().replace(/^\/\/\s?/, ""))
      .join(" ")
      .trim();
    return text.length > 0 ? { text, endLine: i } : null;
  }

  return null;
}

/**
 * §10: "Contains the path, the import specifiers, the exported signatures, and the
 * leading docblock — not the bodies." A genuine summary, not a truncation of the file's
 * top — assembled from the parsed structure plus the leading-docblock scan above.
 *
 * **Truncation rule**: if the assembled body would push the chunk over
 * `FILE_HEADER_TARGET_TOKENS_MAX`, the exported-signature list is trimmed — longest
 * entry dropped first — until the chunk fits or the list is empty. A signature itself is
 * never cut mid-text; only whole entries are removed.
 *
 * **`startLine`/`endLine`**: `1` through the last line covered by the imports and the
 * leading docblock — capped so it never crosses into the first top-level symbol's own
 * range (a file with an unusual import/symbol interleaving must not let this synthetic
 * chunk's declared range overlap a real symbol's chunk).
 */
function buildFileHeaderChunk(
  file: ChunkableFile,
  sourceLines: readonly string[],
): CodeChunkDraft {
  const leadingDoc = extractLeadingDocblock(sourceLines);

  const importSpecifiers = [...new Set(file.imports.map((i) => i.specifier))];
  const exportedTopLevel = file.symbols
    .filter((s) => s.isExported && !s.parentSymbol)
    .map((s) => ({ name: s.name, signature: s.signature }));

  const lastImportLine = file.imports.reduce(
    (max, i) => Math.max(max, i.line),
    0,
  );
  const firstSymbolLine = file.symbols.reduce(
    (min, s) => Math.min(min, s.startLine),
    Number.POSITIVE_INFINITY,
  );
  const rawEndLine = Math.max(1, lastImportLine, leadingDoc?.endLine ?? 0);
  const endLine = Number.isFinite(firstSymbolLine)
    ? Math.min(rawEndLine, Math.max(1, firstSymbolLine - 1))
    : rawEndLine;

  const bodyFor = (
    entries: readonly { name: string; signature: string }[],
  ): string => {
    const parts: string[] = [];
    if (leadingDoc) parts.push(leadingDoc.text);
    if (importSpecifiers.length > 0) {
      parts.push(`Imports: ${importSpecifiers.join(", ")}`);
    }
    if (entries.length > 0) {
      parts.push(
        `Exports:\n${entries.map((e) => `  ${e.signature}`).join("\n")}`,
      );
    }
    return parts.join("\n");
  };

  let remaining = [...exportedTopLevel];
  let chunk = buildChunk(
    file.filePath,
    "FILE_HEADER",
    null,
    1,
    endLine,
    bodyFor(remaining),
    remaining.map((e) => e.name),
    importSpecifiers,
    null,
  );

  // Drop the longest signature first until the chunk fits the token band, or nothing is
  // left to drop. Dropping is by (name, signature) pair together, so the `symbols` field
  // and the body's signature list never desync.
  while (
    chunk.tokenCount > FILE_HEADER_TARGET_TOKENS_MAX &&
    remaining.length > 0
  ) {
    const longestIndex = remaining.reduce(
      (bestIdx, entry, idx, arr) =>
        entry.signature.length > (arr[bestIdx]?.signature.length ?? 0)
          ? idx
          : bestIdx,
      0,
    );
    remaining = remaining.filter((_, idx) => idx !== longestIndex);
    chunk = buildChunk(
      file.filePath,
      "FILE_HEADER",
      null,
      1,
      endLine,
      bodyFor(remaining),
      remaining.map((e) => e.name),
      importSpecifiers,
      null,
    );
  }

  return chunk;
}

// ---------------------------------------------------------------------------
// Oversized-symbol splitting — brace-depth heuristic over the symbol's own line range
// ---------------------------------------------------------------------------

/** Running brace depth after each line, relative to `0` at the symbol's own first line
 * (before its opening brace is processed). A good split point is a line whose depth is
 * back at `1` — inside the symbol's own top-level block, not nested inside a further
 * `if`/`for`/etc. — this is the "nested-statement boundary" heuristic §10 calls for,
 * approximated without a live AST via simple depth counting on `{`/`}` characters. This
 * is a heuristic, not a parser: a brace inside a string/template literal or comment is
 * counted like any other character, which can occasionally misplace a candidate split
 * point — acceptable, since a misplaced split still lands at *some* line boundary
 * (never mid-line) and the fallback ladder below still produces a usable window either
 * way. */
function computeRelativeBraceDepths(lines: readonly string[]): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const line of lines) {
    for (const ch of line) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    depths.push(depth);
  }
  return depths;
}

const SYMBOL_TOP_LEVEL_DEPTH = 1;
/** How far (in lines) from the ideal, size-driven cut point this search is willing to
 * look for a brace-depth-1 or blank-line split candidate before giving up and hard
 * cutting exactly at the ideal point. */
const SPLIT_SEARCH_RADIUS_LINES = 15;

/** The split-point ladder: (1) nearest brace-depth-1 line within the search radius,
 * preferring the closest one to `idealEnd`; (2) nearest blank line within the same
 * radius; (3) a hard cut exactly at `idealEnd`. Never mid-line — every candidate and the
 * fallback are both whole line indices. */
function findSplitPoint(
  idealEnd: number,
  lowerBound: number,
  upperBound: number,
  depths: readonly number[],
  lines: readonly string[],
): number {
  let bestDepthMatch: number | null = null;
  let bestDepthDistance = Number.POSITIVE_INFINITY;
  let bestBlank: number | null = null;
  let bestBlankDistance = Number.POSITIVE_INFINITY;

  const from = Math.max(lowerBound, idealEnd - SPLIT_SEARCH_RADIUS_LINES);
  const to = Math.min(upperBound, idealEnd + SPLIT_SEARCH_RADIUS_LINES);
  for (let i = from; i <= to; i++) {
    const distance = Math.abs(i - idealEnd);
    if (depths[i] === SYMBOL_TOP_LEVEL_DEPTH && distance < bestDepthDistance) {
      bestDepthMatch = i;
      bestDepthDistance = distance;
    }
    if ((lines[i] ?? "").trim() === "" && distance < bestBlankDistance) {
      bestBlank = i;
      bestBlankDistance = distance;
    }
  }

  return bestDepthMatch ?? bestBlank ?? idealEnd;
}

interface LineRange {
  startLine: number;
  endLine: number;
}

/**
 * §10: larger symbols split at nested-statement boundaries into ~`SPLIT_WINDOW_TOKENS`
 * windows with `SPLIT_OVERLAP_RATIO` overlap. Returns 1-based inclusive line ranges,
 * relative to the whole file (already offset by `symbol.startLine`), covering the whole
 * symbol with no gap — consecutive ranges overlap by design.
 */
function splitOversizedSymbol(
  symbolStartLine: number,
  bodyLines: readonly string[],
): LineRange[] {
  const totalLines = bodyLines.length;
  if (totalLines === 0)
    return [{ startLine: symbolStartLine, endLine: symbolStartLine }];

  const depths = computeRelativeBraceDepths(bodyLines);
  const targetChars = SPLIT_WINDOW_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
  const overlapChars = targetChars * SPLIT_OVERLAP_RATIO;

  const ranges: LineRange[] = [];
  let windowStart = 0;

  while (windowStart < totalLines) {
    let chars = 0;
    let idealEnd = windowStart;
    for (let i = windowStart; i < totalLines; i++) {
      chars += (bodyLines[i] ?? "").length + 1;
      idealEnd = i;
      if (chars >= targetChars) break;
    }

    if (idealEnd >= totalLines - 1) {
      ranges.push({
        startLine: symbolStartLine + windowStart,
        endLine: symbolStartLine + totalLines - 1,
      });
      break;
    }

    const splitEnd = findSplitPoint(
      idealEnd,
      windowStart,
      totalLines - 1,
      depths,
      bodyLines,
    );
    ranges.push({
      startLine: symbolStartLine + windowStart,
      endLine: symbolStartLine + splitEnd,
    });

    // Next window backs up by ~overlapChars worth of lines from splitEnd, always making
    // forward progress by at least one line.
    let overlapAccum = 0;
    let nextStart = splitEnd;
    while (nextStart > windowStart && overlapAccum < overlapChars) {
      overlapAccum += (bodyLines[nextStart] ?? "").length + 1;
      nextStart -= 1;
    }
    windowStart = Math.max(nextStart + 1, windowStart + 1);
  }

  return ranges;
}

// ---------------------------------------------------------------------------
// Per-top-level-symbol classification
// ---------------------------------------------------------------------------

type SymbolClass = "tiny" | "standalone" | "oversized";

function classifySymbol(
  file: ChunkableFile,
  symbol: ChunkableSymbol,
  sourceLines: readonly string[],
): { symbolClass: SymbolClass; tokenCount: number } {
  const body = sliceLines(sourceLines, symbol.startLine, symbol.endLine).join(
    "\n",
  );
  const header = formatChunkHeader({
    filePath: file.filePath,
    symbolName: symbol.name,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
  });
  const tokenCount = estimateTokens(`${header}\n${body}`);

  if (tokenCount >= SYMBOL_CHUNK_MAX_TOKENS)
    return { symbolClass: "oversized", tokenCount };
  if (tokenCount < NEIGHBORHOOD_MIN_SYMBOL_TOKENS)
    return { symbolClass: "tiny", tokenCount };
  return { symbolClass: "standalone", tokenCount };
}

// ---------------------------------------------------------------------------
// The main entry point
// ---------------------------------------------------------------------------

/**
 * Builds every non-`FILE_HEADER` chunk from `file`'s top-level symbols
 * (`parentSymbol === undefined` — methods are covered by their enclosing class's own
 * chunk and never emitted separately, §2.4/3.3), in file order:
 *
 * - An **oversized** symbol (`tokenCount >= SYMBOL_CHUNK_MAX_TOKENS`) splits into one or
 *   more `WINDOW`-kind chunks (see `splitOversizedSymbol`) — `WINDOW`, not `SYMBOL`,
 *   matching `@repo/shared`'s own `CHUNK_KINDS` comment ("larger ones split into
 *   `WINDOW`-shaped pieces"); each carries `anchorSymbolName`/`symbols` naming the
 *   symbol it's a piece of, which is exactly what distinguishes a split-symbol `WINDOW`
 *   chunk from a true unparseable-file `WINDOW` chunk (window-chunker.ts's own chunks
 *   always have `anchorSymbolName: null`).
 * - A **tiny** symbol (`tokenCount < NEIGHBORHOOD_MIN_SYMBOL_TOKENS`) is never its own
 *   chunk — it is folded into a run of consecutive tiny symbols, which becomes one or
 *   more `NEIGHBORHOOD` chunks (capped at `NEIGHBORHOOD_MAX_TOKENS`; a run that would
 *   exceed the cap splits into multiple `NEIGHBORHOOD` chunks rather than one oversized
 *   one). "Adjacent" is defined purely as *consecutive in file order among top-level
 *   symbols* — a comment or blank line between two tiny symbols does not break the run,
 *   since neither is itself a top-level symbol that would need its own chunk.
 * - Anything else becomes a single `SYMBOL` chunk covering exactly that symbol's range.
 *
 * **Between-symbol content** (§3.3 rule 5: module-level statements between symbols must
 * never be silently dropped) is folded into the chunk that immediately follows the gap —
 * each chunk's `startLine` is pulled back to one past the previous chunk's `endLine` — or,
 * for a trailing gap after the last symbol, into the chunk that precedes it (its
 * `endLine` is pushed forward to the file's last line). This never crosses into another
 * symbol's own range, since gaps by construction only occur *between* two symbols that
 * already have their own chunks.
 */
function buildSymbolChunks(
  file: ChunkableFile,
  sourceLines: readonly string[],
  fileHeaderEndLine: number,
): CodeChunkDraft[] {
  const topLevel = [...file.symbols]
    .filter((s) => s.parentSymbol === undefined)
    .sort((a, b) => a.startLine - b.startLine);

  const chunks: CodeChunkDraft[] = [];
  let tinyRun: { symbol: ChunkableSymbol; tokenCount: number }[] = [];

  const flushTinyRun = (): void => {
    if (tinyRun.length === 0) return;
    let group: { symbol: ChunkableSymbol; tokenCount: number }[] = [];

    const flushGroup = (): void => {
      if (group.length === 0) return;
      const first = group[0]!.symbol;
      const last = group[group.length - 1]!.symbol;
      const body = sliceLines(sourceLines, first.startLine, last.endLine).join(
        "\n",
      );
      chunks.push(
        buildChunk(
          file.filePath,
          "NEIGHBORHOOD",
          null,
          first.startLine,
          last.endLine,
          body,
          group.map((g) => g.symbol.name),
          [],
          null,
        ),
      );
      group = [];
    };

    for (const entry of tinyRun) {
      const candidateGroup = [...group, entry];
      const first = candidateGroup[0]!.symbol;
      const last = candidateGroup[candidateGroup.length - 1]!.symbol;
      const body = sliceLines(sourceLines, first.startLine, last.endLine).join(
        "\n",
      );
      const header = formatChunkHeader({
        filePath: file.filePath,
        symbolName: null,
        startLine: first.startLine,
        endLine: last.endLine,
      });
      const candidateTokens = estimateTokens(`${header}\n${body}`);

      if (candidateTokens > NEIGHBORHOOD_MAX_TOKENS && group.length > 0) {
        flushGroup();
        group = [entry];
      } else {
        group = candidateGroup;
      }
    }
    flushGroup();
    tinyRun = [];
  };

  for (const symbol of topLevel) {
    const { symbolClass } = classifySymbol(file, symbol, sourceLines);

    if (symbolClass === "tiny") {
      tinyRun.push({ symbol, tokenCount: 0 });
      continue;
    }
    flushTinyRun();

    if (symbolClass === "oversized") {
      const bodyLines = sliceLines(
        sourceLines,
        symbol.startLine,
        symbol.endLine,
      );
      const ranges = splitOversizedSymbol(symbol.startLine, bodyLines);
      for (const range of ranges) {
        const body = sliceLines(
          sourceLines,
          range.startLine,
          range.endLine,
        ).join("\n");
        chunks.push(
          buildChunk(
            file.filePath,
            "WINDOW",
            symbol.name,
            range.startLine,
            range.endLine,
            body,
            [symbol.name],
            [],
            symbol.name,
          ),
        );
      }
      continue;
    }

    // standalone
    const body = sliceLines(sourceLines, symbol.startLine, symbol.endLine).join(
      "\n",
    );
    chunks.push(
      buildChunk(
        file.filePath,
        "SYMBOL",
        symbol.name,
        symbol.startLine,
        symbol.endLine,
        body,
        [symbol.name],
        [],
        symbol.name,
      ),
    );
  }
  flushTinyRun();

  chunks.sort((a, b) => a.startLine - b.startLine);

  // Fold between-symbol gaps into the neighboring chunk — see this function's own
  // header comment for the policy. The leading gap (between FILE_HEADER's own declared
  // range and the first real chunk) is folded the same way, using fileHeaderEndLine as
  // the "previous chunk's endLine" for index 0.
  for (let i = 0; i < chunks.length; i++) {
    const prevEndLine = i === 0 ? fileHeaderEndLine : chunks[i - 1]!.endLine;
    const current = chunks[i]!;
    if (current.startLine > prevEndLine + 1) {
      const extendedStart = prevEndLine + 1;
      const extraBody = sliceLines(
        sourceLines,
        extendedStart,
        current.startLine - 1,
      ).join("\n");
      chunks[i] = rebuildWithExtendedRange(
        file.filePath,
        current,
        extendedStart,
        current.endLine,
        extraBody,
        true,
      );
    }
  }
  const last = chunks[chunks.length - 1];
  if (last && last.endLine < sourceLines.length) {
    const extraBody = sliceLines(
      sourceLines,
      last.endLine + 1,
      sourceLines.length,
    ).join("\n");
    if (extraBody.trim().length > 0) {
      chunks[chunks.length - 1] = rebuildWithExtendedRange(
        file.filePath,
        last,
        last.startLine,
        sourceLines.length,
        extraBody,
        false,
      );
    }
  }

  return chunks;
}

/** Rebuilds a chunk with an extended line range and gap content prepended/appended to
 * its body — used only by the gap-folding pass above, which needs to recompute
 * `content`/`contentHash`/`tokenCount` after widening a chunk's declared range. Symbol
 * anchoring (`symbols`/`anchorSymbolName`) is left unchanged: folded gap content is
 * un-symboled module-level text, not a symbol this chunk now also represents. */
function rebuildWithExtendedRange(
  filePath: string,
  chunk: CodeChunkDraft,
  startLine: number,
  endLine: number,
  gapBody: string,
  gapBeforeExisting: boolean,
): CodeChunkDraft {
  const existingBody = chunk.content.split("\n").slice(1).join("\n");
  const symbolNameForHeader = chunk.anchorSymbolName;
  const body = gapBeforeExisting
    ? `${gapBody}\n${existingBody}`
    : `${existingBody}\n${gapBody}`;
  const header = formatChunkHeader({
    filePath,
    symbolName: symbolNameForHeader,
    startLine,
    endLine,
  });
  const content = `${header}\n${body}`;
  return {
    ...chunk,
    startLine,
    endLine,
    content,
    contentHash: computeContentHash(content),
    tokenCount: estimateTokens(content),
  };
}

/**
 * The AST chunker's entry point — called by `chunkFile` (index.ts's router) when
 * `parseState === "OK"` and `symbols.length > 0`. `source` is the file's raw text; `file`
 * is a `ParsedFile`-shaped value (structurally, per this module's header comment).
 */
export function chunkFileWithAst(
  file: ChunkableFile,
  source: string,
): CodeChunkDraft[] {
  const sourceLines = source.split("\n");
  const fileHeader = buildFileHeaderChunk(file, sourceLines);
  const symbolChunks = buildSymbolChunks(file, sourceLines, fileHeader.endLine);
  return [fileHeader, ...symbolChunks];
}

// ---------------------------------------------------------------------------
// Invariants — executable, not just prose (sub-task 3.3's own requirement)
// ---------------------------------------------------------------------------

export class ChunkInvariantViolation extends Error {}

/**
 * Verifies, for `chunks` produced from `file`:
 *
 * 1. Chunks are ordered by `startLine`.
 * 2. No chunk's `startLine` falls strictly inside a top-level symbol's range unless
 *    that chunk is a `WINDOW`-kind split piece anchored to that same symbol
 *    (`anchorSymbolName === symbol.name`).
 * 3. Every line of every top-level symbol is covered by at least one chunk.
 * 4. Every chunk's `content` begins with the provenance header (`// FILE: `).
 *
 * Throws {@link ChunkInvariantViolation} with a descriptive message on the first
 * violation found, rather than collecting every violation — this is a correctness gate
 * for tests, not a lint report.
 */
export function assertChunkInvariants(
  chunks: readonly CodeChunkDraft[],
  file: ChunkableFile,
): void {
  for (let i = 1; i < chunks.length; i++) {
    if (chunks[i]!.startLine < chunks[i - 1]!.startLine) {
      throw new ChunkInvariantViolation(
        `chunks are not ordered by startLine at index ${String(i)}`,
      );
    }
  }

  const topLevelSymbols = file.symbols.filter(
    (s) => s.parentSymbol === undefined,
  );

  for (const chunk of chunks) {
    if (!chunk.content.startsWith("// FILE: ")) {
      throw new ChunkInvariantViolation(
        `chunk at line ${String(chunk.startLine)} does not begin with the provenance header`,
      );
    }
    for (const symbol of topLevelSymbols) {
      const startsInside =
        chunk.startLine > symbol.startLine && chunk.startLine <= symbol.endLine;
      if (!startsInside) continue;
      const isSplitWindowOfThisSymbol =
        chunk.chunkKind === "WINDOW" && chunk.anchorSymbolName === symbol.name;
      if (!isSplitWindowOfThisSymbol) {
        throw new ChunkInvariantViolation(
          `chunk starting at line ${String(chunk.startLine)} starts mid-symbol ` +
            `"${symbol.name}" (lines ${String(symbol.startLine)}-${String(symbol.endLine)})`,
        );
      }
    }
  }

  for (const symbol of topLevelSymbols) {
    for (let line = symbol.startLine; line <= symbol.endLine; line++) {
      const covered = chunks.some(
        (c) => c.startLine <= line && line <= c.endLine,
      );
      if (!covered) {
        throw new ChunkInvariantViolation(
          `line ${String(line)} of symbol "${symbol.name}" is not covered by any chunk`,
        );
      }
    }
  }
}
