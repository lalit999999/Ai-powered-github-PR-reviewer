import { createHash } from "node:crypto";
import type { ChunkKind } from "@repo/shared";

/**
 * Phase 05 prompt 3, sub-task 3.2: the chunker's output shape. Deliberately NOT
 * `@repo/db`'s `ChunkUpsertInput` — the chunker knows nothing about database ids
 * (`fileId`, `symbolId`, `repositoryId`) or embeddings, mirroring how
 * `parsed-file.types.ts` keeps the parsing layer database-free. Prompt 4's pipeline maps
 * this into `ChunkUpsertInput`, resolving `anchorSymbolName` to a `CodeSymbol.id` and
 * filling in the ids/embedding this layer has no way to know.
 */
export interface CodeChunkDraft {
  chunkKind: ChunkKind;
  /** 1-based, inclusive — same convention as `ParsedSymbol` (apps/worker's
   * parsed-file.types.ts). */
  startLine: number;
  endLine: number;
  /** Includes the one-line provenance header — see {@link formatChunkHeader}. The
   * header is embedded and retrieved with the chunk, which is the point: a retrieved
   * fragment with no header says nothing about where it came from. */
  content: string;
  /** sha256 of {@link content} (header + body together) — see {@link computeContentHash}
   * for why the header is part of what gets hashed. */
  contentHash: string;
  tokenCount: number;
  /** Symbol names this chunk covers, denormalized for `CodeChunk.symbols`. Empty for a
   * `WINDOW` chunk (no symbol data available). */
  symbols: string[];
  /** Import specifiers in scope, denormalized for `CodeChunk.imports`. Populated only on
   * the `FILE_HEADER` chunk — every other chunk kind carries an empty array, since an
   * import statement is file-scoped, not symbol-scoped. */
  imports: string[];
  /** The symbol this chunk is anchored to, if exactly one — null for `FILE_HEADER`
   * (no single symbol), `NEIGHBORHOOD` (multiple, no single anchor), and `WINDOW` (no
   * symbol data at all). Prompt 4 resolves a non-null value to a `CodeSymbol.id`; this
   * layer has no ids to resolve to. */
  anchorSymbolName: string | null;
}

// ---------------------------------------------------------------------------
// The one-line provenance header — one function, so the format is identical and
// testable everywhere it's produced (ast-chunker.ts, window-chunker.ts).
// ---------------------------------------------------------------------------

export interface ChunkHeaderInput {
  filePath: string;
  /** null renders as "—" (em dash) — used for `FILE_HEADER` (no single anchor symbol),
   * `NEIGHBORHOOD` (multiple coalesced symbols, no single anchor), and every `WINDOW`
   * chunk (no symbol data at all). Kept as one glyph rather than an empty string so the
   * header's field count/shape never varies — "SYMBOL: —" is still readable as
   * "no symbol", and the format stays trivially parseable by simple splitting. */
  symbolName: string | null;
  startLine: number;
  endLine: number;
}

const NO_SYMBOL_MARKER = "—";

/** `// FILE: ... | SYMBOL: ... | LINES ...` — spec §10's exact format. One function, so
 * every chunk kind (ast-chunker.ts's FILE_HEADER/SYMBOL/NEIGHBORHOOD chunks,
 * window-chunker.ts's WINDOW chunks) produces byte-identical header shape. */
export function formatChunkHeader(input: ChunkHeaderInput): string {
  const symbol = input.symbolName ?? NO_SYMBOL_MARKER;
  return `// FILE: ${input.filePath} | SYMBOL: ${symbol} | LINES ${input.startLine.toString()}-${input.endLine.toString()}`;
}

// ---------------------------------------------------------------------------
// Content hash — header + body together, sha256/hex to match walk-tree.ts's own
// hashing (createHash("sha256")....digest("hex")), so every content-hash in this system
// uses the same algorithm and encoding.
// ---------------------------------------------------------------------------

/**
 * Hashes `content` — the chunk's full text, header included — not just the body. Two
 * identical function bodies at different file paths embed different headers (different
 * `FILE:` values), so they hash differently and never collide in the global
 * `EmbeddingCache`; a single shared body at one path chunked twice, deterministically,
 * hashes identically both times (sub-task 3.5's determinism test).
 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
