import { describe, expect, it } from "vitest";
import { WINDOW_CHUNK_LINES, WINDOW_OVERLAP_LINES } from "@repo/shared";
import { chunkFileWithWindows } from "./window-chunker.js";

function makeLines(n: number): string {
  return Array.from(
    { length: n },
    (_, i) => `line ${String(i + 1)} of content`,
  ).join("\n");
}

describe("chunkFileWithWindows", () => {
  it("emits zero chunks for an empty file", () => {
    expect(chunkFileWithWindows("", "src/empty.ts")).toEqual([]);
  });

  it("emits zero chunks for a whitespace-only file", () => {
    expect(chunkFileWithWindows("   \n\t\n   \n", "src/blank.ts")).toEqual([]);
  });

  it("emits exactly one chunk covering the whole file when shorter than one window", () => {
    const source = makeLines(WINDOW_CHUNK_LINES - 5);
    const chunks = chunkFileWithWindows(source, "src/short.ts");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(WINDOW_CHUNK_LINES - 5);
    expect(chunks[0]!.chunkKind).toBe("WINDOW");
    expect(chunks[0]!.anchorSymbolName).toBeNull();
    expect(chunks[0]!.symbols).toEqual([]);
  });

  it("folds a below-threshold trailing remainder into the previous window instead of emitting an orphan", () => {
    // WINDOW_CHUNK_LINES + a small remainder (well under a quarter window) — must not
    // produce a tiny final chunk.
    const total = WINDOW_CHUNK_LINES + 4;
    const source = makeLines(total);
    const chunks = chunkFileWithWindows(source, "src/orphan.ts");

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(total);
  });

  it("produces overlapping windows for a file spanning several full windows", () => {
    const total = WINDOW_CHUNK_LINES * 3;
    const source = makeLines(total);
    const chunks = chunkFileWithWindows(source, "src/long.ts");

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[chunks.length - 1]!.endLine).toBe(total);

    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const current = chunks[i]!;
      // Adjacent windows overlap by exactly WINDOW_OVERLAP_LINES, except possibly the
      // final window, which may have been extended to fold in an orphan remainder.
      if (i < chunks.length - 1) {
        expect(prev.endLine - current.startLine + 1).toBe(WINDOW_OVERLAP_LINES);
      }
      expect(current.startLine).toBeLessThanOrEqual(prev.endLine);
    }

    // Every line of the file is covered.
    for (let line = 1; line <= total; line++) {
      expect(chunks.some((c) => c.startLine <= line && line <= c.endLine)).toBe(
        true,
      );
    }
  });

  it("every chunk's content begins with the provenance header and carries no symbol data", () => {
    const source = makeLines(WINDOW_CHUNK_LINES * 2);
    const chunks = chunkFileWithWindows(source, "src/long.ts");
    for (const chunk of chunks) {
      expect(
        chunk.content.startsWith("// FILE: src/long.ts | SYMBOL: — | LINES"),
      ).toBe(true);
      expect(chunk.symbols).toEqual([]);
      expect(chunk.imports).toEqual([]);
      expect(chunk.anchorSymbolName).toBeNull();
    }
  });

  it("is deterministic across repeated calls, including every contentHash", () => {
    const source = makeLines(WINDOW_CHUNK_LINES * 2 + 7);
    const first = chunkFileWithWindows(source, "src/repeat.ts");
    const second = chunkFileWithWindows(source, "src/repeat.ts");
    expect(second).toEqual(first);
  });
});
