import { afterAll, describe, expect, it } from "vitest";
import {
  ContentTooLargeError,
  disposeAll,
  getOutstandingTreeCount,
  getParseErrorInfo,
  MAX_PARSE_CONTENT_BYTES,
  selectLanguage,
  withParsedTree,
} from "./parser-pool.js";

afterAll(async () => {
  await disposeAll();
});

describe("selectLanguage", () => {
  it("maps every parse-eligible extension to its grammar", () => {
    expect(selectLanguage("src/index.ts")).toBe("typescript");
    expect(selectLanguage("src/index.mts")).toBe("typescript");
    expect(selectLanguage("src/index.cts")).toBe("typescript");
    expect(selectLanguage("src/App.tsx")).toBe("tsx");
    expect(selectLanguage("src/index.js")).toBe("javascript");
    expect(selectLanguage("src/index.jsx")).toBe("javascript");
    expect(selectLanguage("src/index.mjs")).toBe("javascript");
    expect(selectLanguage("src/index.cjs")).toBe("javascript");
  });

  it("is case-insensitive on the extension", () => {
    expect(selectLanguage("src/index.TS")).toBe("typescript");
  });

  it("returns null for non-parse-eligible extensions", () => {
    expect(selectLanguage("README.md")).toBeNull();
    expect(selectLanguage("package.json")).toBeNull();
    expect(selectLanguage("logo.png")).toBeNull();
    expect(selectLanguage("Makefile")).toBeNull();
  });
});

describe("withParsedTree", () => {
  it("parses a well-formed TypeScript snippet with no errors", async () => {
    const source = `
      export interface Foo {
        bar(): number;
      }
      export class Baz implements Foo {
        bar(): number { return 1; }
      }
    `;
    const info = await withParsedTree("typescript", source, (tree) => getParseErrorInfo(tree));
    expect(info.hasError).toBe(false);
    expect(info.errorNodeCount).toBe(0);
  });

  it("parses a well-formed TSX snippet with no errors", async () => {
    const source = `
      export function Greeting({ name }: { name: string }) {
        return <div className="greeting">Hello, {name}!</div>;
      }
    `;
    const info = await withParsedTree("tsx", source, (tree) => getParseErrorInfo(tree));
    expect(info.hasError).toBe(false);
  });

  it("parses a well-formed JavaScript snippet with no errors", async () => {
    const source = `
      function add(a, b) {
        return a + b;
      }
      export default add;
    `;
    const info = await withParsedTree("javascript", source, (tree) => getParseErrorInfo(tree));
    expect(info.hasError).toBe(false);
  });

  it("a syntactically broken snippet returns a tree with hasError=true rather than throwing", async () => {
    const broken = "function foo( {\n  return 1\n";
    await expect(withParsedTree("typescript", broken, (tree) => tree.rootNode.hasError)).resolves.toBe(true);
  });

  it("getParseErrorInfo reports at least one ERROR node for broken input", async () => {
    const broken = "function foo( {\n  return 1\n";
    const info = await withParsedTree("typescript", broken, (tree) => getParseErrorInfo(tree));
    expect(info.hasError).toBe(true);
    expect(info.errorNodeCount).toBeGreaterThan(0);
  });

  it("getParseErrorInfo also counts MISSING nodes (an unbalanced/truncated closing brace produces no ERROR node at all, only MISSING ones)", async () => {
    const truncated = "function foo() {\n  if (true) {\n    return 1;\n";
    const info = await withParsedTree("typescript", truncated, (tree) => getParseErrorInfo(tree));
    expect(info.hasError).toBe(true);
    expect(info.errorNodeCount).toBeGreaterThan(0);
  });

  it("throws ContentTooLargeError for content over the guard, without parsing it", async () => {
    const huge = "a".repeat(MAX_PARSE_CONTENT_BYTES + 1);
    await expect(withParsedTree("javascript", huge, () => "unreachable")).rejects.toBeInstanceOf(ContentTooLargeError);
  });

  it("accepts content exactly at the guard", async () => {
    // Valid-enough JS padding so the parse itself is trivial; the guard is a byte-length
    // check before parsing, not a parse-success check.
    const atLimit = "//" + "a".repeat(MAX_PARSE_CONTENT_BYTES - 2);
    await expect(withParsedTree("javascript", atLimit, () => "ok")).resolves.toBe("ok");
  });

  it("the tree is disposed after every call — no trees remain outstanding", async () => {
    expect(getOutstandingTreeCount()).toBe(0);
    for (let i = 0; i < 25; i++) {
      await withParsedTree("javascript", `const x${i.toString()} = ${i.toString()};`, (tree) => tree.rootNode.text);
      expect(getOutstandingTreeCount()).toBe(0);
    }
  });

  it("the tree is disposed even when the callback throws", async () => {
    expect(getOutstandingTreeCount()).toBe(0);
    await expect(
      withParsedTree("javascript", "const x = 1;", () => {
        throw new Error("callback failure");
      }),
    ).rejects.toThrow("callback failure");
    expect(getOutstandingTreeCount()).toBe(0);
  });

  it("concurrent calls across languages all resolve correctly (shared init/grammar promises)", async () => {
    const [ts, tsx, js] = await Promise.all([
      withParsedTree("typescript", "const x: number = 1;", (tree) => tree.rootNode.hasError),
      withParsedTree("tsx", "const el = <div />;", (tree) => tree.rootNode.hasError),
      withParsedTree("javascript", "const x = 1;", (tree) => tree.rootNode.hasError),
    ]);
    expect([ts, tsx, js]).toEqual([false, false, false]);
  });
});
