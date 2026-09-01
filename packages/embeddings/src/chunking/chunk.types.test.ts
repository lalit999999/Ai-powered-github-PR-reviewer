import { describe, expect, it } from "vitest";
import {
  computeContentHash,
  formatChunkHeader,
} from "./chunk.types.js";

describe("formatChunkHeader", () => {
  it("produces the exact spec §10 format with a symbol name", () => {
    const header = formatChunkHeader({
      filePath: "src/foo.ts",
      symbolName: "doThing",
      startLine: 10,
      endLine: 42,
    });
    expect(header).toBe("// FILE: src/foo.ts | SYMBOL: doThing | LINES 10-42");
  });

  it("renders a null symbolName as the em dash marker", () => {
    const header = formatChunkHeader({
      filePath: "src/foo.ts",
      symbolName: null,
      startLine: 1,
      endLine: 5,
    });
    expect(header).toBe("// FILE: src/foo.ts | SYMBOL: — | LINES 1-5");
  });
});

describe("computeContentHash", () => {
  it("is stable across repeated calls with the same content", () => {
    const content = "// FILE: a.ts | SYMBOL: foo | LINES 1-3\nfunction foo() {}";
    expect(computeContentHash(content)).toBe(computeContentHash(content));
  });

  it("differs for identical bodies at different paths — the header carries the path", () => {
    const body = "function foo() { return 1; }";
    const headerA = formatChunkHeader({
      filePath: "src/a.ts",
      symbolName: "foo",
      startLine: 1,
      endLine: 1,
    });
    const headerB = formatChunkHeader({
      filePath: "src/b.ts",
      symbolName: "foo",
      startLine: 1,
      endLine: 1,
    });
    const hashA = computeContentHash(`${headerA}\n${body}`);
    const hashB = computeContentHash(`${headerB}\n${body}`);
    expect(hashA).not.toBe(hashB);
  });

  it("is a 64-character hex sha256 digest", () => {
    const hash = computeContentHash("anything");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
