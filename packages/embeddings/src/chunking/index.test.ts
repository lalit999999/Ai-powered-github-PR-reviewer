import { describe, expect, it } from "vitest";
import { chunkFile } from "./index.js";
import type { ChunkableFile } from "./ast-chunker.js";

describe("chunkFile router", () => {
  it("routes a FAILED parse to the window chunker", () => {
    const file: ChunkableFile = {
      filePath: "src/broken.ts",
      imports: [],
      symbols: [],
      parseState: "FAILED",
    };
    const source = `this is }} not { valid typescript at all (((`;
    const chunks = chunkFile(file, source);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.chunkKind).toBe("WINDOW");
      expect(chunk.anchorSymbolName).toBeNull();
    }
  });

  it("routes an OK parse with zero symbols to the window chunker — a barrel/re-export-only file", () => {
    // Mirrors apps/worker/tests/fixtures/parsing/barrel.ts: a file whose only content is
    // re-export statements, which produce ParsedImport entries but no ParsedSymbol.
    const source = [
      `// A barrel file`,
      `export * from "./button";`,
      `export * from "./input";`,
      `export * from "./modal";`,
      `export { theme } from "./theme";`,
    ].join("\n");
    const file: ChunkableFile = {
      filePath: "src/index.ts",
      imports: [
        { specifier: "./button", line: 2 },
        { specifier: "./input", line: 3 },
        { specifier: "./modal", line: 4 },
        { specifier: "./theme", line: 5 },
      ],
      symbols: [],
      parseState: "OK",
    };
    const chunks = chunkFile(file, source);

    // Shorter than one window — window-chunker.ts's own "file shorter than one window"
    // rule means this lands as exactly one WINDOW chunk covering the whole file, so no
    // content is lost even though the AST chunker's FILE_HEADER summary is skipped.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.chunkKind).toBe("WINDOW");
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(5);
  });

  it("routes an OK parse with symbols to the AST chunker", () => {
    const source = [
      `export function hello(): string {`,
      `  return "hi";`,
      `}`,
    ].join("\n");
    const file: ChunkableFile = {
      filePath: "src/hello.ts",
      imports: [],
      symbols: [
        {
          name: "hello",
          startLine: 1,
          endLine: 3,
          isExported: true,
          signature: "export function hello(): string",
        },
      ],
      parseState: "OK",
    };
    const chunks = chunkFile(file, source);
    expect(chunks.some((c) => c.chunkKind === "FILE_HEADER")).toBe(true);
  });

  it("emits zero chunks end-to-end for an empty file", () => {
    const file: ChunkableFile = {
      filePath: "src/empty.ts",
      imports: [],
      symbols: [],
      parseState: "OK",
    };
    expect(chunkFile(file, "")).toEqual([]);
  });

  it("a comments-only file (OK, zero symbols) produces a single sensible WINDOW chunk covering it", () => {
    const source = [
      `// This file intentionally contains only comments — no declarations at all.`,
      `// It exists to document a convention, not to export anything.`,
      `// See apps/worker/tests/fixtures/parsing/comments-only.ts for the parser-side twin.`,
    ].join("\n");
    const file: ChunkableFile = {
      filePath: "src/comments-only.ts",
      imports: [],
      symbols: [],
      parseState: "OK",
    };
    const chunks = chunkFile(file, source);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.chunkKind).toBe("WINDOW");
    expect(chunks[0]!.content).toContain(
      "intentionally contains only comments",
    );
  });
});
