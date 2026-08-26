import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { disposeAll, type ParserLanguage } from "../tree-sitter/parser-pool.js";
import type { ParsedFile } from "../parsed-file.types.js";
import { isParseRefusal, parseFile } from "./typescript.adapter.js";

/**
 * Sub-task 2.6's golden-file suite: real, on-disk fixture files under
 * `apps/worker/tests/fixtures/parsing/` — one construct family per file, each a
 * realistic snippet rather than a synthetic toy (§2.6's own instruction) — run through
 * the real `parseFile`. Every assertion below is an explicit expected value (names,
 * kinds, exact line numbers, export flags, call lists) — **never a snapshot**: a
 * snapshot test that silently re-baselines is worse than no test here, because the
 * failure mode this phase fears most is *silently wrong extraction*, which a
 * re-baselined snapshot would quietly enshrine (§2.6's own instruction).
 *
 * This file lives under `src/` (not `tests/`) so it runs via `pnpm --filter worker
 * test:unit` — `vitest.config.ts`'s `include` only picks up `src/**\/*.test.ts`; the
 * fixtures themselves are plain data files elsewhere and never need to match that glob.
 */

const FIXTURES_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../tests/fixtures/parsing");

async function parseFixture(filename: string): Promise<ParsedFile> {
  const filePath = path.join(FIXTURES_DIR, filename);
  const source = await fs.readFile(filePath, "utf8");
  const ext = path.extname(filename);
  const language: ParserLanguage = ext === ".tsx" ? "tsx" : ext === ".js" ? "javascript" : "typescript";
  const result = await parseFile(filename, language, source);
  if (isParseRefusal(result)) throw new Error(`fixture ${filename} was refused: ${result.reason}`);
  return result;
}

afterAll(async () => {
  await disposeAll();
});

describe("golden fixtures", () => {
  it("barrel.ts — a chain of export * from re-exports", async () => {
    const parsed = await parseFixture("barrel.ts");
    const reExportTargets = parsed.exports.filter((e) => e.reExportFrom).map((e) => e.reExportFrom);
    expect(reExportTargets.sort()).toEqual(["./button", "./input", "./modal", "./theme"].sort());
    // Each re-export is also a file-level import edge (the "dual nature" contract).
    for (const target of ["./button", "./input", "./modal", "./theme"]) {
      expect(parsed.imports).toContainEqual(expect.objectContaining({ specifier: target }));
    }
  });

  it("export-star.ts — export * from specifically", async () => {
    const parsed = await parseFixture("export-star.ts");
    expect(parsed.exports).toContainEqual(expect.objectContaining({ name: "", reExportFrom: "./utils" }));
  });

  it("dynamic-imports.ts — literal specifier resolved, non-literal never fabricated", async () => {
    const parsed = await parseFixture("dynamic-imports.ts");
    expect(parsed.imports).toContainEqual(expect.objectContaining({ specifier: "./widget", syntax: "dynamic" }));
    expect(parsed.imports.filter((i) => i.syntax === "dynamic")).toHaveLength(1);
    expect(byName(parsed, "loadWidget").kind).toBe("FUNCTION");
    expect(byName(parsed, "loadDynamic").kind).toBe("FUNCTION");
  });

  it("decorators.ts — a class decorator (field) and a method decorator (sibling) both extend startLine", async () => {
    const parsed = await parseFixture("decorators.ts");
    const service = byName(parsed, "WidgetService");
    expect(service.kind).toBe("CLASS");
    // `@Injectable()` is on the line immediately before `export class WidgetService`.
    const source = await fs.readFile(path.join(FIXTURES_DIR, "decorators.ts"), "utf8");
    const decoratorLine = source.split("\n").findIndex((l) => l.includes("@Injectable")) + 1;
    expect(service.startLine).toBe(decoratorLine);

    const render = byName(parsed, "render");
    expect(render.parentSymbol).toBe("WidgetService");
    const renderDecoratorLine = source.split("\n").findIndex((l, i) => l.includes("@Input") && i > source.split("\n").findIndex((x) => x.includes("label"))) + 1;
    expect(render.startLine).toBe(renderDecoratorLine);
  });

  it("jsx-components.tsx — component requires JSX, hook requires the ^use[A-Z] name, PascalCase alone is not enough", async () => {
    const parsed = await parseFixture("jsx-components.tsx");
    expect(byName(parsed, "useCounter").kind).toBe("HOOK");
    expect(byName(parsed, "Counter").kind).toBe("REACT_COMPONENT");
    expect(byName(parsed, "Registry").kind).toBe("FUNCTION");
  });

  it("default-exports.ts — named default declaration is both exported and default", async () => {
    const parsed = await parseFixture("default-exports.ts");
    const formatDate = byName(parsed, "formatDate");
    expect(formatDate.isExported).toBe(true);
    expect(formatDate.isDefault).toBe(true);
    expect(parsed.exports).toContainEqual(expect.objectContaining({ name: "formatDate", isDefault: true }));
  });

  it("namespace-imports.ts", async () => {
    const parsed = await parseFixture("namespace-imports.ts");
    expect(parsed.imports).toContainEqual(expect.objectContaining({ specifier: "node:path", namespace: "path" }));
    const joinPaths = byName(parsed, "joinPaths");
    expect(joinPaths.calls).toContainEqual(expect.objectContaining({ name: "join", receiver: "path" }));
  });

  it("type-only-imports.ts — whole-statement and mixed per-specifier forms both correct", async () => {
    const parsed = await parseFixture("type-only-imports.ts");
    const wholeStatement = parsed.imports.find((i) => i.named.includes("Request"));
    expect(wholeStatement?.isTypeOnly).toBe(true);
    expect(wholeStatement?.named.sort()).toEqual(["Request", "Response"].sort());

    const fromExpress = parsed.imports.filter((i) => i.specifier === "express" && i.named.includes("Router"));
    expect(fromExpress).toHaveLength(1);
    expect(fromExpress[0]?.isTypeOnly).toBe(false);
    expect(fromExpress[0]?.named).toContain("Router");
    expect(fromExpress[0]?.named).not.toContain("NextFunction");

    const typeOnlySpecifier = parsed.imports.find((i) => i.specifier === "express" && i.named.includes("NextFunction"));
    expect(typeOnlySpecifier?.isTypeOnly).toBe(true);
  });

  it("overloaded-functions.ts — exactly one symbol, not three, no duplicate ranges", async () => {
    const parsed = await parseFixture("overloaded-functions.ts");
    const parseValueSymbols = parsed.symbols.filter((s) => s.name === "parseValue");
    expect(parseValueSymbols).toHaveLength(1);
    expect(parseValueSymbols[0]?.signature).toContain("string | number");
  });

  it("abstract-classes.ts — abstract class and abstract method both extracted with the right kinds", async () => {
    const parsed = await parseFixture("abstract-classes.ts");
    const shape = byName(parsed, "Shape");
    expect(shape.kind).toBe("CLASS");
    const area = parsed.symbols.find((s) => s.name === "area" && s.parentSymbol === "Shape");
    expect(area?.kind).toBe("METHOD");
    const circle = byName(parsed, "Circle");
    expect(circle.extends).toEqual(["Shape"]);
  });

  it("generics.ts — generic type parameters do not break symbol detection or blow up the signature", async () => {
    const parsed = await parseFixture("generics.ts");
    const firstMatch = byName(parsed, "firstMatch");
    expect(firstMatch.kind).toBe("FUNCTION");
    expect(firstMatch.signature.length).toBeLessThan(600);
    const cache = byName(parsed, "Cache");
    expect(cache.kind).toBe("CLASS");
  });

  it("ambient-declarations.ts — the declare-module block produces no symbols; the real function outside it still does", async () => {
    const parsed = await parseFixture("ambient-declarations.ts");
    expect(parsed.symbols.find((s) => s.name === "legacyFn")).toBeUndefined();
    expect(byName(parsed, "readLegacyLib").kind).toBe("FUNCTION");
  });

  it("class-members.ts — getters, setters, and static methods are all METHOD; the private field is not a symbol at all", async () => {
    const parsed = await parseFixture("class-members.ts");
    for (const name of ["fahrenheit", "create"]) {
      const matches = parsed.symbols.filter((s) => s.name === name && s.parentSymbol === "Temperature");
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) expect(m.kind).toBe("METHOD");
    }
    expect(parsed.symbols.filter((s) => s.name === "fahrenheit")).toHaveLength(2); // getter + setter
    expect(parsed.symbols.find((s) => s.name === "celsius")).toBeUndefined();
    expect(parsed.symbols.find((s) => s.name === "defaultUnit")).toBeUndefined();
  });

  it("object-literal-members.ts — no object-literal method/arrow/function-expression becomes a symbol", async () => {
    const parsed = await parseFixture("object-literal-members.ts");
    expect(parsed.symbols).toEqual([]);
  });

  it("malformed.ts — FAILED, not thrown, with real ERROR nodes counted", async () => {
    const source = await fs.readFile(path.join(FIXTURES_DIR, "malformed.ts"), "utf8");
    const result = await parseFile("malformed.ts", "typescript", source);
    expect(isParseRefusal(result)).toBe(false);
    if (!isParseRefusal(result)) {
      expect(result.parseState).toBe("FAILED");
      expect(result.parseErrors).toBeGreaterThan(0);
    }
  });

  it("ts-only-syntax.ts parses cleanly under the typescript grammar", async () => {
    const parsed = await parseFixture("ts-only-syntax.ts");
    expect(parsed.parseState).toBe("OK");
    expect(byName(parsed, "Config").kind).toBe("INTERFACE");
    expect(byName(parsed, "Handler").kind).toBe("TYPE_ALIAS");
  });

  it("ts-only-syntax.ts's own text produces real parse errors under the plain javascript grammar — the empirical basis for this fixture pair's own header comment", async () => {
    // Asserts parseErrors > 0 specifically, not parseState — whether this particular
    // file's error *ratio* crosses this adapter's own FAILED threshold is a separate,
    // independently-tuned concern (see the malformed.ts test) from the claim this test
    // makes: that TypeScript-only syntax is genuinely unparseable by the plain JS
    // grammar, not merely "different-looking but still valid".
    const source = await fs.readFile(path.join(FIXTURES_DIR, "ts-only-syntax.ts"), "utf8");
    const result = await parseFile("ts-only-syntax.js", "javascript", source);
    expect(isParseRefusal(result)).toBe(false);
    if (!isParseRefusal(result)) {
      expect(result.parseErrors).toBeGreaterThan(0);
    }
  });

  it("empty.ts parses OK with no symbols — a legitimate empty file, not a refusal", async () => {
    const parsed = await parseFixture("empty.ts");
    expect(parsed.parseState).toBe("OK");
    expect(parsed.symbols).toEqual([]);
    expect(parsed.imports).toEqual([]);
    expect(parsed.exports).toEqual([]);
  });

  it("comments-only.ts parses OK with no symbols", async () => {
    const parsed = await parseFixture("comments-only.ts");
    expect(parsed.parseState).toBe("OK");
    expect(parsed.symbols).toEqual([]);
  });

  it("line-numbers.ts — hand-counted line pinning (see the fixture file's own inline // line N markers, counted by hand against `cat -n`)", async () => {
    const parsed = await parseFixture("line-numbers.ts");

    const annotated = byName(parsed, "annotated");
    expect(annotated.startLine).toBe(3); // the doc comment start, per the fixture's own "line 4" marker being ON line 4 (the block opens on line 3)
    expect(annotated.endLine).toBe(9);
    expect(annotated.docComment).toBe("line 4 - doc comment start");

    const widget = byName(parsed, "Widget");
    expect(widget.startLine).toBe(12);
    expect(widget.endLine).toBe(17);

    // render's startLine includes the immediately-preceding "// line 13" comment (no
    // blank line separates them) — the same doc-comment-adjacency rule exercised above.
    const render = byName(parsed, "render");
    expect(render.startLine).toBe(13);
    expect(render.endLine).toBe(16);
    expect(render.docComment).toBe("line 13");
    expect(render.parentSymbol).toBe("Widget");
  });
});

function byName(parsed: ParsedFile, name: string) {
  const found = parsed.symbols.find((s) => s.name === name);
  if (!found) throw new Error(`expected a symbol named "${name}" among: ${parsed.symbols.map((s) => s.name).join(", ")}`);
  return found;
}
