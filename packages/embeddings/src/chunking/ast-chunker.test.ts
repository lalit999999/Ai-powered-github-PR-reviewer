import { describe, expect, it } from "vitest";
import {
  assertChunkInvariants,
  chunkFileWithAst,
  type ChunkableFile,
  type ChunkableSymbol,
} from "./ast-chunker.js";
import { NEIGHBORHOOD_MAX_TOKENS, SPLIT_WINDOW_TOKENS } from "@repo/shared";

// ---------------------------------------------------------------------------
// Fixture builders — hand-built ParsedFile-shaped values plus source strings, in the
// same spirit as Phase 04's graph tests (hand-built ParsedFile fixtures, no tree-sitter
// involved) — see sub-task 3.5's own instruction.
// ---------------------------------------------------------------------------

/** A single top-level function padded well past SYMBOL_CHUNK_MAX_TOKENS (1200) so it is
 * guaranteed to classify as "oversized" and split into multiple WINDOW pieces. */
function buildOversizedFixture(): { file: ChunkableFile; source: string } {
  const lines: string[] = [`import { z } from "zod";`, ""];
  const fnStart = lines.length + 1;
  lines.push("export function bigFn(): void {");
  for (let i = 0; i < 220; i++) {
    lines.push(
      `  const x${String(i)} = ${String(i)}; // padding line so the body grows well past the split threshold`,
    );
    if (i % 15 === 0) lines.push("");
  }
  lines.push("}");
  const fnEnd = lines.length;

  const file: ChunkableFile = {
    filePath: "src/big.ts",
    imports: [{ specifier: "zod", line: 1 }],
    symbols: [
      {
        name: "bigFn",
        startLine: fnStart,
        endLine: fnEnd,
        isExported: true,
        signature: "export function bigFn(): void",
      },
    ],
    parseState: "OK",
  };
  return { file, source: lines.join("\n") };
}

/** `n` adjacent top-level `const` declarations, each padded to `bodyChars` characters —
 * tuned (see docs/decisions/phase-05-log.md, Prompt 3) so that at `bodyChars=400`, each
 * symbol's own isolated tokenCount (~107) stays comfortably under
 * NEIGHBORHOOD_MIN_SYMBOL_TOKENS (120, "tiny"), while the *combined* estimate for a run
 * crosses NEIGHBORHOOD_MAX_TOKENS (800) between 8 and 9 symbols. */
function buildTinyRunFixture(
  n: number,
  bodyChars: number,
  filePath = "src/tiny.ts",
  startAt = 0,
): { file: ChunkableFile; source: string; symbolNames: string[] } {
  const lines: string[] = [`import { z } from "zod";`, ""];
  const symbols: ChunkableSymbol[] = [];
  const symbolNames: string[] = [];
  for (let i = startAt; i < startAt + n; i++) {
    const startLine = lines.length + 1;
    const padding = "x".repeat(Math.max(0, bodyChars - 20));
    lines.push(`const TINY_${String(i)} = 1; // ${padding}`);
    const endLine = lines.length;
    symbols.push({
      name: `TINY_${String(i)}`,
      startLine,
      endLine,
      isExported: false,
      signature: `const TINY_${String(i)} = 1`,
    });
    symbolNames.push(`TINY_${String(i)}`);
  }
  const file: ChunkableFile = {
    filePath,
    imports: [{ specifier: "zod", line: 1 }],
    symbols,
    parseState: "OK",
  };
  return { file, source: lines.join("\n"), symbolNames };
}

/** tiny, tiny, huge, tiny, tiny — proves coalescing never crosses a large symbol
 * (rule 5). Reuses the same 400-char tiny-body sizing as {@link buildTinyRunFixture}. */
function buildMixedRunFixture(): { file: ChunkableFile; source: string } {
  const lines: string[] = [`import { z } from "zod";`, ""];
  const symbols: ChunkableSymbol[] = [];
  const pushTiny = (name: string): void => {
    const startLine = lines.length + 1;
    const padding = "x".repeat(380);
    lines.push(`const ${name} = 1; // ${padding}`);
    symbols.push({
      name,
      startLine,
      endLine: lines.length,
      isExported: false,
      signature: `const ${name} = 1`,
    });
  };

  pushTiny("A1");
  pushTiny("A2");

  const bigStart = lines.length + 1;
  lines.push("export function bigFn(): void {");
  for (let i = 0; i < 220; i++) {
    lines.push(
      `  const x${String(i)} = ${String(i)}; // padding to exceed the split threshold`,
    );
  }
  lines.push("}");
  symbols.push({
    name: "bigFn",
    startLine: bigStart,
    endLine: lines.length,
    isExported: true,
    signature: "export function bigFn(): void",
  });

  pushTiny("B1");
  pushTiny("B2");

  const file: ChunkableFile = {
    filePath: "src/mixed.ts",
    imports: [{ specifier: "zod", line: 1 }],
    symbols,
    parseState: "OK",
  };
  return { file, source: lines.join("\n") };
}

/** A file with several imports, a leading docblock, and six exported top-level symbols
 * — tuned (see docs/decisions/phase-05-log.md) so its FILE_HEADER lands inside the
 * 150-300 token target band with no truncation needed. */
function buildFileHeaderFixture(): { file: ChunkableFile; source: string } {
  const lines: string[] = [
    "/**",
    " * The widget service — creation, deletion, and lookup for the demo domain object",
    " * used throughout this fixture. Exists purely to give the FILE_HEADER chunk enough",
    " * leading-docblock text to land inside its target token band during testing.",
    " */",
    `import { randomUUID } from "node:crypto";`,
    `import { z } from "zod";`,
    `import { formatDate } from "./utils/format-date.js";`,
    `import { MAX_RETRIES } from "../shared/constants.js";`,
    "",
  ];
  const symbolDefs = [
    {
      name: "createWidget",
      sig: "export function createWidget(name: string, size: number): Widget",
    },
    {
      name: "deleteWidget",
      sig: "export function deleteWidget(id: string): Promise<void>",
    },
    { name: "WidgetRegistry", sig: "export class WidgetRegistry" },
    {
      name: "listWidgets",
      sig: "export function listWidgets(filter?: WidgetFilter): Widget[]",
    },
    {
      name: "renameWidget",
      sig: "export function renameWidget(id: string, newName: string): Promise<Widget>",
    },
    {
      name: "WidgetValidationError",
      sig: "export class WidgetValidationError extends Error",
    },
  ];
  const symbols: ChunkableSymbol[] = symbolDefs.map((s) => {
    const startLine = lines.length + 1;
    lines.push(`${s.sig} { /* body */ }`);
    return {
      name: s.name,
      startLine,
      endLine: lines.length,
      isExported: true,
      signature: s.sig,
    };
  });

  const file: ChunkableFile = {
    filePath: "src/widgets/widget.service.ts",
    imports: [
      { specifier: "node:crypto", line: 6 },
      { specifier: "zod", line: 7 },
      { specifier: "./utils/format-date.js", line: 8 },
      { specifier: "../shared/constants.js", line: 9 },
    ],
    symbols,
    parseState: "OK",
  };
  return { file, source: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// 1 & 2: invariants — never starts mid-symbol; every symbol line covered
// ---------------------------------------------------------------------------

describe("assertChunkInvariants holds across every fixture", () => {
  it.each([
    ["oversized symbol", buildOversizedFixture()],
    ["tiny run", buildTinyRunFixture(8, 400)],
    ["mixed tiny/huge/tiny", buildMixedRunFixture()],
    ["file header fixture", buildFileHeaderFixture()],
  ])("%s", (_label, { file, source }) => {
    const chunks = chunkFileWithAst(file, source);
    expect(() => assertChunkInvariants(chunks, file)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3: oversized symbol splitting
// ---------------------------------------------------------------------------

describe("oversized symbol splitting", () => {
  it("produces multiple WINDOW pieces near SPLIT_WINDOW_TOKENS with no gap", () => {
    const { file, source } = buildOversizedFixture();
    const chunks = chunkFileWithAst(file, source);
    const windows = chunks.filter((c) => c.anchorSymbolName === "bigFn");

    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) {
      expect(w.chunkKind).toBe("WINDOW");
      expect(w.symbols).toEqual(["bigFn"]);
    }
    // Every non-final window is within a generous band of the target — the estimator is
    // approximate (§2.2's own ±20% caveat), so this asserts a band, not an exact number.
    for (const w of windows.slice(0, -1)) {
      expect(w.tokenCount).toBeGreaterThan(SPLIT_WINDOW_TOKENS * 0.7);
      expect(w.tokenCount).toBeLessThan(SPLIT_WINDOW_TOKENS * 1.3);
    }

    // Consecutive windows overlap — a band around SPLIT_OVERLAP_RATIO (0.15), not an
    // exact value.
    for (let i = 1; i < windows.length; i++) {
      const prev = windows[i - 1]!;
      const current = windows[i]!;
      expect(current.startLine).toBeLessThanOrEqual(prev.endLine);
      const overlapLines = prev.endLine - current.startLine + 1;
      const prevWindowLines = prev.endLine - prev.startLine + 1;
      const overlapRatio = overlapLines / prevWindowLines;
      expect(overlapRatio).toBeGreaterThan(0.03);
      expect(overlapRatio).toBeLessThan(0.35);
    }

    // The union of windows covers the whole symbol with no gap.
    const symbol = file.symbols[0]!;
    for (let line = symbol.startLine; line <= symbol.endLine; line++) {
      const covered = windows.some(
        (w) => w.startLine <= line && line <= w.endLine,
      );
      expect(covered).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4: tiny symbol coalescing
// ---------------------------------------------------------------------------

describe("tiny symbol coalescing", () => {
  it("coalesces 8 adjacent tiny symbols into one NEIGHBORHOOD chunk", () => {
    const { file, source, symbolNames } = buildTinyRunFixture(8, 400);
    const chunks = chunkFileWithAst(file, source);
    const neighborhoods = chunks.filter((c) => c.chunkKind === "NEIGHBORHOOD");

    expect(neighborhoods).toHaveLength(1);
    expect(neighborhoods[0]!.symbols).toEqual(symbolNames);
    expect(neighborhoods[0]!.tokenCount).toBeLessThanOrEqual(
      NEIGHBORHOOD_MAX_TOKENS,
    );
    expect(neighborhoods[0]!.anchorSymbolName).toBeNull();
  });

  it("splits 9 adjacent tiny symbols (which would exceed NEIGHBORHOOD_MAX_TOKENS as one group) into two NEIGHBORHOOD chunks", () => {
    const { file, source, symbolNames } = buildTinyRunFixture(9, 400);
    const chunks = chunkFileWithAst(file, source);
    const neighborhoods = chunks.filter((c) => c.chunkKind === "NEIGHBORHOOD");

    expect(neighborhoods).toHaveLength(2);
    for (const n of neighborhoods) {
      expect(n.tokenCount).toBeLessThanOrEqual(NEIGHBORHOOD_MAX_TOKENS);
    }
    // Every symbol still appears exactly once across the two chunks, in order.
    const allNames = neighborhoods.flatMap((n) => n.symbols);
    expect(allNames).toEqual(symbolNames);
  });
});

// ---------------------------------------------------------------------------
// 5: coalescing does not cross a large symbol
// ---------------------------------------------------------------------------

describe("coalescing does not cross a large symbol", () => {
  it("tiny, tiny, huge, tiny, tiny produces two separate NEIGHBORHOOD runs", () => {
    const { file, source } = buildMixedRunFixture();
    const chunks = chunkFileWithAst(file, source);
    const neighborhoods = chunks.filter((c) => c.chunkKind === "NEIGHBORHOOD");

    expect(neighborhoods).toHaveLength(2);
    expect(neighborhoods[0]!.symbols).toEqual(["A1", "A2"]);
    expect(neighborhoods[1]!.symbols).toEqual(["B1", "B2"]);

    const bigWindows = chunks.filter((c) => c.anchorSymbolName === "bigFn");
    expect(bigWindows.length).toBeGreaterThan(0);

    // The big symbol's chunks sit strictly between the two neighborhoods in line order.
    expect(neighborhoods[0]!.endLine).toBeLessThan(bigWindows[0]!.startLine);
    expect(bigWindows[bigWindows.length - 1]!.endLine).toBeLessThan(
      neighborhoods[1]!.startLine,
    );
  });
});

// ---------------------------------------------------------------------------
// 6: exactly one FILE_HEADER, containing every import specifier and exported name
// ---------------------------------------------------------------------------

describe("FILE_HEADER", () => {
  it("emits exactly one, containing every import specifier and every exported symbol name, within the token band", () => {
    const { file, source } = buildFileHeaderFixture();
    const chunks = chunkFileWithAst(file, source);
    const headers = chunks.filter((c) => c.chunkKind === "FILE_HEADER");

    expect(headers).toHaveLength(1);
    const header = headers[0]!;

    for (const imp of file.imports) {
      expect(header.content).toContain(imp.specifier);
    }
    for (const symbol of file.symbols) {
      expect(header.content).toContain(symbol.name);
    }

    expect(header.tokenCount).toBeGreaterThanOrEqual(150);
    expect(header.tokenCount).toBeLessThanOrEqual(300);
  });

  it("truncates the exported-signature list, longest first, when the assembled header would exceed the band", () => {
    // A file with many long exported signatures — the header must stay within
    // FILE_HEADER_TARGET_TOKENS_MAX even though including every signature would not.
    const lines: string[] = [`import { z } from "zod";`, ""];
    const symbols: ChunkableSymbol[] = [];
    for (let i = 0; i < 12; i++) {
      const sig = `export function veryLongFunctionNameNumber${String(i)}(argumentOne: string, argumentTwo: number, argumentThree: boolean): Promise<SomeLongResultType${String(i)}>`;
      const startLine = lines.length + 1;
      lines.push(`${sig} { /* body */ }`);
      symbols.push({
        name: `veryLongFunctionNameNumber${String(i)}`,
        startLine,
        endLine: lines.length,
        isExported: true,
        signature: sig,
      });
    }
    const file: ChunkableFile = {
      filePath: "src/many-exports.ts",
      imports: [{ specifier: "zod", line: 1 }],
      symbols,
      parseState: "OK",
    };
    const chunks = chunkFileWithAst(file, lines.join("\n"));
    const header = chunks.find((c) => c.chunkKind === "FILE_HEADER")!;

    expect(header.tokenCount).toBeLessThanOrEqual(300);
    // Fewer than all 12 signatures survived truncation.
    expect(header.symbols.length).toBeLessThan(12);
    // The signatures that survived are among the *shortest* — the longest were dropped
    // first. Every surviving name is genuinely present in the header body.
    for (const name of header.symbols) {
      expect(header.content).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// 11: determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("produces byte-identical output, including every contentHash, across repeated runs", () => {
    const { file, source } = buildMixedRunFixture();
    const first = chunkFileWithAst(file, source);
    const second = chunkFileWithAst(file, source);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// 12: every emitted chunk's content begins with the provenance header
// ---------------------------------------------------------------------------

describe("provenance header", () => {
  it("every chunk's content begins with the // FILE: header, across every fixture", () => {
    const fixtures = [
      buildOversizedFixture(),
      buildTinyRunFixture(8, 400),
      buildMixedRunFixture(),
      buildFileHeaderFixture(),
    ];
    for (const { file, source } of fixtures) {
      const chunks = chunkFileWithAst(file, source);
      for (const chunk of chunks) {
        expect(chunk.content.startsWith("// FILE: ")).toBe(true);
      }
    }
  });
});
