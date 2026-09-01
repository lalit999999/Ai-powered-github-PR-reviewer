import { chunkFileWithAst, type ChunkableFile } from "./ast-chunker.js";
import type { CodeChunkDraft } from "./chunk.types.js";
import { chunkFileWithWindows } from "./window-chunker.js";

export type { CodeChunkDraft, ChunkHeaderInput } from "./chunk.types.js";
export { computeContentHash, formatChunkHeader } from "./chunk.types.js";
export {
  assertChunkInvariants,
  chunkFileWithAst,
  ChunkInvariantViolation,
  type ChunkableFile,
  type ChunkableImport,
  type ChunkableSymbol,
} from "./ast-chunker.js";
export { chunkFileWithWindows } from "./window-chunker.js";
export { CHARS_PER_TOKEN_ESTIMATE, estimateTokens } from "./token-estimator.js";

/**
 * The single dispatch point Prompt 4's pipeline calls. Predicate: the AST chunker runs
 * when `parseState === "OK"` **and** `symbols.length > 0`; every other case — `FAILED`,
 * `NOT_PARSED`, or an `OK` parse that legitimately found zero top-level symbols (a pure
 * re-export barrel file, e.g. `apps/worker/tests/fixtures/parsing/barrel.ts`) — falls
 * back to the window chunker.
 *
 * "OK but zero symbols" is a deliberate, not accidental, route to the window chunker:
 * the AST chunker's whole design is built around top-level symbols to anchor chunks to,
 * and a file with none has nothing for it to anchor around. The cost is real but small —
 * such a file loses `FILE_HEADER`'s synthesized import/export summary and instead gets
 * literal line-window chunks of its (typically short) body — and the window chunker's
 * own "file shorter than one window → one chunk covering the whole file" rule means a
 * small barrel file still becomes exactly one chunk, so no content is lost, only the
 * synthetic summary framing.
 */
export function chunkFile(file: ChunkableFile, source: string): CodeChunkDraft[] {
  if (file.parseState === "OK" && file.symbols.length > 0) {
    return chunkFileWithAst(file, source);
  }
  return chunkFileWithWindows(source, file.filePath);
}
