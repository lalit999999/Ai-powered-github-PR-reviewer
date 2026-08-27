import { afterAll, describe, expect, it } from "vitest";
import {
  disposeAll,
  MAX_PARSE_CONTENT_BYTES,
} from "../tree-sitter/parser-pool.js";
import type { ParsedFile } from "../parsed-file.types.js";
import {
  isParseRefusal,
  isTrustworthyParse,
  parseFile,
  type ParseFileResult,
} from "./typescript.adapter.js";

afterAll(async () => {
  await disposeAll();
});

/** Every test parses real, non-refused input — narrows `ParseFileResult` down to
 * `ParsedFile` once, here, so the rest of the suite can assert on `ParsedFile` fields
 * directly instead of repeating the refusal-narrowing dance in every test. */
async function parseOk(
  language: "typescript" | "tsx" | "javascript",
  source: string,
): Promise<ParsedFile> {
  const result: ParseFileResult = await parseFile(
    `test.${language === "typescript" ? "ts" : language === "tsx" ? "tsx" : "js"}`,
    language,
    source,
  );
  if (isParseRefusal(result))
    throw new Error(
      `expected a parsed result, got a refusal: ${result.reason}`,
    );
  return result;
}

function byName<T extends { name: string }>(items: T[], name: string): T {
  const found = items.find((item) => item.name === name);
  if (!found)
    throw new Error(
      `expected an entry named "${name}" among: ${items.map((i) => i.name).join(", ")}`,
    );
  return found;
}

// ---------------------------------------------------------------------------
// Sub-task 2.2 — imports and exports
// ---------------------------------------------------------------------------

describe("imports", () => {
  it("default import", async () => {
    const parsed = await parseOk("typescript", `import Default from "./m";`);
    expect(parsed.imports).toContainEqual(
      expect.objectContaining({
        specifier: "./m",
        default: "Default",
        isTypeOnly: false,
        syntax: "static",
      }),
    );
  });

  it("named import with alias — named[] carries the local bound name, not the original", async () => {
    const parsed = await parseOk(
      "typescript",
      `import { a, b as c } from "./m";`,
    );
    const imp = parsed.imports.find((i) => i.specifier === "./m");
    expect(imp?.named.sort()).toEqual(["a", "c"]);
  });

  it("namespace import", async () => {
    const parsed = await parseOk("typescript", `import * as ns from "./m";`);
    expect(parsed.imports).toContainEqual(
      expect.objectContaining({ specifier: "./m", namespace: "ns" }),
    );
  });

  it("side-effect-only import has no bindings", async () => {
    const parsed = await parseOk("typescript", `import "./side-effect";`);
    const imp = parsed.imports[0];
    expect(imp).toBeDefined();
    expect(imp?.specifier).toBe("./side-effect");
    expect(imp?.named).toEqual([]);
    expect(imp?.default).toBeUndefined();
    expect(imp?.namespace).toBeUndefined();
  });

  it("whole-statement type-only import", async () => {
    const parsed = await parseOk("typescript", `import type { T } from "./m";`);
    const imp = parsed.imports.find((i) => i.specifier === "./m");
    expect(imp?.isTypeOnly).toBe(true);
    expect(imp?.named).toEqual(["T"]);
  });

  it("mixed per-specifier type-only import splits into two entries", async () => {
    const parsed = await parseOk(
      "typescript",
      `import { type T, value } from "./m";`,
    );
    const fromM = parsed.imports.filter((i) => i.specifier === "./m");
    expect(fromM).toHaveLength(2);
    const typeOnlyEntry = fromM.find((i) => i.isTypeOnly);
    const valueEntry = fromM.find((i) => !i.isTypeOnly);
    expect(typeOnlyEntry?.named).toEqual(["T"]);
    expect(valueEntry?.named).toEqual(["value"]);
  });

  it("CJS require()", async () => {
    const parsed = await parseOk("javascript", `const m = require("./cjs");`);
    expect(parsed.imports).toContainEqual(
      expect.objectContaining({ specifier: "./cjs", syntax: "require" }),
    );
  });

  it("CJS require() with destructuring still produces one import entry for the specifier", async () => {
    const parsed = await parseOk(
      "javascript",
      `const { a } = require("./cjs");`,
    );
    expect(parsed.imports).toContainEqual(
      expect.objectContaining({ specifier: "./cjs", syntax: "require" }),
    );
  });

  it("dynamic import() with a literal specifier", async () => {
    const parsed = await parseOk(
      "typescript",
      `const m = import("./dynamic");`,
    );
    expect(parsed.imports).toContainEqual(
      expect.objectContaining({ specifier: "./dynamic", syntax: "dynamic" }),
    );
  });

  it("dynamic import() with a non-literal specifier produces no import entry at all — never fabricated", async () => {
    const parsed = await parseOk(
      "typescript",
      `const p = "./m"; const m = import(p);`,
    );
    expect(parsed.imports.find((i) => i.syntax === "dynamic")).toBeUndefined();
  });

  it("require() is not also emitted as a call — it is only an import", async () => {
    const parsed = await parseOk(
      "javascript",
      `
      function loader() {
        const m = require("./cjs");
        return m;
      }
      `,
    );
    const loader = byName(parsed.symbols, "loader");
    expect(loader.calls.find((c) => c.name === "require")).toBeUndefined();
  });
});

describe("exports", () => {
  it("export { a } from './m' is a re-export — appears in both exports[] and imports[]", async () => {
    const parsed = await parseOk("typescript", `export { a } from "./m";`);
    expect(parsed.exports).toContainEqual(
      expect.objectContaining({ name: "a", reExportFrom: "./m" }),
    );
    expect(parsed.imports).toContainEqual(
      expect.objectContaining({ specifier: "./m", named: [] }),
    );
  });

  it("export * from './m'", async () => {
    const parsed = await parseOk("typescript", `export * from "./m";`);
    expect(parsed.exports).toContainEqual(
      expect.objectContaining({ name: "", reExportFrom: "./m" }),
    );
    expect(parsed.imports).toContainEqual(
      expect.objectContaining({ specifier: "./m" }),
    );
  });

  it("export * as ns from './m'", async () => {
    const parsed = await parseOk("typescript", `export * as ns from "./m";`);
    expect(parsed.exports).toContainEqual(
      expect.objectContaining({ name: "ns", reExportFrom: "./m" }),
    );
    expect(parsed.imports).toContainEqual(
      expect.objectContaining({ specifier: "./m" }),
    );
  });

  it("export default function foo() {} is default AND named", async () => {
    const parsed = await parseOk(
      "typescript",
      `export default function foo() {}`,
    );
    expect(parsed.exports).toContainEqual(
      expect.objectContaining({ name: "foo", isDefault: true }),
    );
    expect(parsed.exports).toHaveLength(1);
  });

  it("export default <identifier> uses the real referenced name, not a fabricated one", async () => {
    const parsed = await parseOk(
      "typescript",
      `const helper = 1; export default helper;`,
    );
    expect(parsed.exports).toContainEqual(
      expect.objectContaining({ name: "helper", isDefault: true }),
    );
  });

  it("export default () => {} (anonymous) has an empty name, never guessed", async () => {
    const parsed = await parseOk("typescript", `export default () => {};`);
    expect(parsed.exports).toContainEqual(
      expect.objectContaining({ name: "", isDefault: true }),
    );
  });

  it("export = Foo (TS interop)", async () => {
    const parsed = await parseOk("typescript", `class Foo {} export = Foo;`);
    expect(parsed.exports).toContainEqual(
      expect.objectContaining({ name: "Foo", isDefault: false }),
    );
  });

  it("indirect export: declared then exported via export { x } elsewhere in the file", async () => {
    const parsed = await parseOk(
      "typescript",
      `function helper() {} export { helper };`,
    );
    const helper = byName(parsed.symbols, "helper");
    expect(helper.isExported).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-task 2.3 — symbols
// ---------------------------------------------------------------------------

describe("symbols — kinds", () => {
  it("function declaration", async () => {
    const parsed = await parseOk("typescript", `function foo() {}`);
    expect(byName(parsed.symbols, "foo").kind).toBe("FUNCTION");
  });

  it("arrow function bound to const", async () => {
    const parsed = await parseOk("typescript", `const foo = () => {};`);
    expect(byName(parsed.symbols, "foo").kind).toBe("ARROW_FUNCTION");
  });

  it("function expression bound to const", async () => {
    const parsed = await parseOk("typescript", `const foo = function () {};`);
    expect(byName(parsed.symbols, "foo").kind).toBe("ARROW_FUNCTION");
  });

  it("class declaration", async () => {
    const parsed = await parseOk("typescript", `class Foo {}`);
    expect(byName(parsed.symbols, "Foo").kind).toBe("CLASS");
  });

  it("abstract class declaration", async () => {
    const parsed = await parseOk(
      "typescript",
      `abstract class Foo { abstract bar(): void; }`,
    );
    expect(byName(parsed.symbols, "Foo").kind).toBe("CLASS");
    expect(byName(parsed.symbols, "bar").kind).toBe("METHOD");
  });

  it("methods — plain, getter, setter, static, constructor, private field methods", async () => {
    const parsed = await parseOk(
      "typescript",
      `
      class Foo {
        constructor() {}
        plain() {}
        get x() { return 1; }
        set x(v: number) {}
        static create() { return new Foo(); }
      }
      `,
    );
    const methodNames = parsed.symbols
      .filter((s) => s.parentSymbol === "Foo")
      .map((s) => s.name);
    expect(methodNames.sort()).toEqual(
      ["constructor", "create", "plain", "x", "x"].sort(),
    );
    for (const name of ["constructor", "plain", "x", "create"]) {
      expect(
        parsed.symbols.find((s) => s.name === name && s.parentSymbol === "Foo")
          ?.kind,
      ).toBe("METHOD");
    }
  });

  it("interface declaration", async () => {
    const parsed = await parseOk(
      "typescript",
      `interface Foo { bar(): void; }`,
    );
    expect(byName(parsed.symbols, "Foo").kind).toBe("INTERFACE");
  });

  it("type alias", async () => {
    const parsed = await parseOk("typescript", `type Foo = { a: number };`);
    expect(byName(parsed.symbols, "Foo").kind).toBe("TYPE_ALIAS");
  });

  it("enum", async () => {
    const parsed = await parseOk("typescript", `enum Foo { A, B }`);
    expect(byName(parsed.symbols, "Foo").kind).toBe("ENUM");
  });

  it("react component: PascalCase + JSX return, TSX only", async () => {
    const parsed = await parseOk(
      "tsx",
      `function Greeting() { return <div>hi</div>; }`,
    );
    expect(byName(parsed.symbols, "Greeting").kind).toBe("REACT_COMPONENT");
  });

  it("PascalCase function with no JSX is NOT a react component (requires JSX, not just the name)", async () => {
    const parsed = await parseOk(
      "tsx",
      `function Registry() { return { get: 1 }; }`,
    );
    expect(byName(parsed.symbols, "Registry").kind).toBe("FUNCTION");
  });

  it("hook: name matches ^use[A-Z]", async () => {
    const parsed = await parseOk(
      "typescript",
      `function useThing() { return 1; }`,
    );
    expect(byName(parsed.symbols, "useThing").kind).toBe("HOOK");
  });

  it("a name starting with 'use' but not capitalized after it is not a hook", async () => {
    const parsed = await parseOk(
      "typescript",
      `function useful() { return 1; }`,
    );
    expect(byName(parsed.symbols, "useful").kind).toBe("FUNCTION");
  });
});

describe("symbols — line ranges (hand-counted against the source)", () => {
  it("pins startLine/endLine exactly — off-by-one guard", async () => {
    // Line 1 is blank (the template literal's own leading newline); `function foo` starts
    // on line 2 and its closing brace is on line 4. Counted by hand, not derived.
    const source = `
function foo() {
  return 1;
}
`;
    const parsed = await parseOk("typescript", source);
    const foo = byName(parsed.symbols, "foo");
    expect(foo.startLine).toBe(2);
    expect(foo.endLine).toBe(4);
  });

  it("startLine includes a leading doc comment", async () => {
    const source = `
/**
 * hello
 */
function foo() {
  return 1;
}
`;
    const parsed = await parseOk("typescript", source);
    const foo = byName(parsed.symbols, "foo");
    expect(foo.startLine).toBe(2);
    expect(foo.endLine).toBe(7);
    expect(foo.docComment).toBe("hello");
  });

  it("startLine includes a decorator on a class", async () => {
    const source = `
@Component()
class Foo {}
`;
    const parsed = await parseOk("typescript", source);
    expect(byName(parsed.symbols, "Foo").startLine).toBe(2);
  });

  it("startLine includes a decorator on a method, which is a sibling, not a child, of it", async () => {
    const source = `
class Foo {
  @Input()
  bar() {}
}
`;
    const parsed = await parseOk("typescript", source);
    expect(byName(parsed.symbols, "bar").startLine).toBe(3);
  });

  it("startLine finds a doc comment through a decorator on the same declaration", async () => {
    const source = `
/** does the thing */
@Input()
bar() {}
`;
    // Wrapped in a class so the decorator/method shape is real syntax.
    const parsed = await parseOk("typescript", `class Foo {\n${source}\n}`);
    const bar = byName(parsed.symbols, "bar");
    expect(bar.docComment).toBe("does the thing");
  });
});

describe("symbols — export flags", () => {
  it("export function foo() {} is exported, not default", async () => {
    const parsed = await parseOk("typescript", `export function foo() {}`);
    const foo = byName(parsed.symbols, "foo");
    expect(foo.isExported).toBe(true);
    expect(foo.isDefault).toBe(false);
  });

  it("export default function foo() {} is exported AND default", async () => {
    const parsed = await parseOk(
      "typescript",
      `export default function foo() {}`,
    );
    const foo = byName(parsed.symbols, "foo");
    expect(foo.isExported).toBe(true);
    expect(foo.isDefault).toBe(true);
  });

  it("a non-exported function is neither", async () => {
    const parsed = await parseOk("typescript", `function foo() {}`);
    const foo = byName(parsed.symbols, "foo");
    expect(foo.isExported).toBe(false);
    expect(foo.isDefault).toBe(false);
  });

  it("export const foo = () => {}", async () => {
    const parsed = await parseOk("typescript", `export const foo = () => {};`);
    expect(byName(parsed.symbols, "foo").isExported).toBe(true);
  });
});

describe("symbols — signature and doc comment bounds", () => {
  it("signature excludes the body", async () => {
    const parsed = await parseOk(
      "typescript",
      `function foo(a: number): number {\n  return a + 1;\n}`,
    );
    const foo = byName(parsed.symbols, "foo");
    expect(foo.signature).toBe("function foo(a: number): number");
    expect(foo.signature).not.toContain("return");
  });

  it("a pathologically long generic signature is truncated, not stored whole", async () => {
    const hugeGeneric = Array.from(
      { length: 200 },
      (_, i) => `T${i.toString()} extends object`,
    ).join(", ");
    const source = `function foo<${hugeGeneric}>(): void {}`;
    const parsed = await parseOk("typescript", source);
    const foo = byName(parsed.symbols, "foo");
    expect(foo.signature.length).toBeLessThan(600);
    expect(foo.signature.endsWith("…")).toBe(true);
  });

  it("doc comment strips block-comment delimiters and leading stars", async () => {
    const source = `
/**
 * Line one.
 * Line two.
 */
function foo() {}
`;
    const parsed = await parseOk("typescript", source);
    expect(byName(parsed.symbols, "foo").docComment).toBe(
      "Line one.\nLine two.",
    );
  });
});

describe("symbols — nesting exclusions", () => {
  it("a closure declared inside a function is not emitted as a top-level symbol", async () => {
    const parsed = await parseOk(
      "typescript",
      `
      function outer() {
        function inner() { return 1; }
        return inner();
      }
      `,
    );
    expect(parsed.symbols.map((s) => s.name)).toEqual(["outer"]);
  });

  it("a const arrow declared inside a function is not emitted as a top-level symbol", async () => {
    const parsed = await parseOk(
      "typescript",
      `
      function outer() {
        const helper = () => 1;
        return helper();
      }
      `,
    );
    expect(parsed.symbols.map((s) => s.name)).toEqual(["outer"]);
  });

  it("an object-literal shorthand method is not emitted as a symbol", async () => {
    const parsed = await parseOk(
      "typescript",
      `const api = { foo() { return 1; }, bar: () => 2, baz: function () { return 3; } };`,
    );
    expect(parsed.symbols.map((s) => s.name)).toEqual([]);
  });
});

describe("symbols — parentSymbol", () => {
  it("a class method's parentSymbol is the class name", async () => {
    const parsed = await parseOk("typescript", `class Foo { bar() {} }`);
    expect(byName(parsed.symbols, "bar").parentSymbol).toBe("Foo");
  });

  it("a top-level function has no parentSymbol", async () => {
    const parsed = await parseOk("typescript", `function foo() {}`);
    expect(byName(parsed.symbols, "foo").parentSymbol).toBeUndefined();
  });
});

describe("symbols — complexity", () => {
  it("a function with no branches has complexity 1", async () => {
    const parsed = await parseOk("typescript", `function foo() { return 1; }`);
    expect(byName(parsed.symbols, "foo").complexity).toBe(1);
  });

  it("a branchier function scores strictly higher than a simpler one", async () => {
    const simple = await parseOk(
      "typescript",
      `function simple() { return 1; }`,
    );
    const branchy = await parseOk(
      "typescript",
      `
      function branchy(a: number) {
        if (a > 0) {
          for (let i = 0; i < a; i++) {
            if (a && i) { continue; }
          }
        } else if (a < 0) {
          return -1;
        }
        return a ? 1 : 0;
      }
      `,
    );
    expect(byName(branchy.symbols, "branchy").complexity).toBeGreaterThan(
      byName(simple.symbols, "simple").complexity,
    );
  });

  it("branches inside an inline callback are not counted toward the enclosing function", async () => {
    const withoutCallback = await parseOk(
      "typescript",
      `function foo(arr: number[]) { return arr; }`,
    );
    const withCallback = await parseOk(
      "typescript",
      `
      function foo(arr: number[]) {
        return arr.filter(function (x) { if (x) { return true; } return false; });
      }
      `,
    );
    expect(byName(withCallback.symbols, "foo").complexity).toBe(
      byName(withoutCallback.symbols, "foo").complexity,
    );
  });

  it("a class/interface/enum/type-alias has baseline complexity 1", async () => {
    const parsed = await parseOk(
      "typescript",
      `class Foo {} interface Bar {} enum Baz { A } type Qux = number;`,
    );
    for (const name of ["Foo", "Bar", "Baz", "Qux"]) {
      expect(byName(parsed.symbols, name).complexity).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Sub-task 2.4 — call sites and class heritage
// ---------------------------------------------------------------------------

describe("calls", () => {
  it("a bare call and a member call are both attributed to the enclosing symbol", async () => {
    const parsed = await parseOk(
      "typescript",
      `
      function outer() {
        foo();
        obj.method();
      }
      `,
    );
    const outer = byName(parsed.symbols, "outer");
    expect(outer.calls).toContainEqual(
      expect.objectContaining({ name: "foo", receiver: undefined }),
    );
    expect(outer.calls).toContainEqual(
      expect.objectContaining({ name: "method", receiver: "obj" }),
    );
  });

  it("a nested-function call is attributed to the innermost tracked enclosing symbol — the untracked inner closure is skipped", async () => {
    const parsed = await parseOk(
      "typescript",
      `
      function outer() {
        function inner() {
          foo();
        }
        inner();
      }
      `,
    );
    const outer = byName(parsed.symbols, "outer");
    expect(outer.calls.map((c) => c.name).sort()).toEqual(
      ["foo", "inner"].sort(),
    );
  });

  it("a call at true module top level is dropped, not attributed to any symbol", async () => {
    const parsed = await parseOk("typescript", `function tracked() {} foo();`);
    const allCalls = parsed.symbols.flatMap((s) => s.calls);
    expect(allCalls.find((c) => c.name === "foo")).toBeUndefined();
  });

  it("deduplicates a repeated identical call within one symbol", async () => {
    const parsed = await parseOk(
      "typescript",
      `
      function foo() {
        logger.info();
        logger.info();
        logger.info();
      }
      `,
    );
    const foo = byName(parsed.symbols, "foo");
    expect(foo.calls.filter((c) => c.name === "info")).toHaveLength(1);
  });

  it("a chained call's receiver is dropped when the receiver is itself a call expression", async () => {
    const parsed = await parseOk(
      "typescript",
      `
      function foo() {
        a.b().c();
      }
      `,
    );
    const foo = byName(parsed.symbols, "foo");
    const callToC = foo.calls.find((c) => c.name === "c");
    expect(callToC?.receiver).toBeUndefined();
  });

  it("a chained call through plain identifiers keeps the whole receiver text", async () => {
    const parsed = await parseOk(
      "typescript",
      `
      function foo() {
        obj.nested.method();
      }
      `,
    );
    const foo = byName(parsed.symbols, "foo");
    expect(foo.calls).toContainEqual(
      expect.objectContaining({ name: "method", receiver: "obj.nested" }),
    );
  });
});

describe("class/interface heritage", () => {
  it("class extends and implements", async () => {
    const parsed = await parseOk(
      "typescript",
      `class Foo extends Base implements IFoo, IBar {}`,
    );
    const foo = byName(parsed.symbols, "Foo");
    expect(foo.extends).toEqual(["Base"]);
    expect(foo.implements?.sort()).toEqual(["IBar", "IFoo"].sort());
  });

  it("interface extends supports multiple parents", async () => {
    const parsed = await parseOk(
      "typescript",
      `interface Foo extends Bar, Baz {}`,
    );
    const foo = byName(parsed.symbols, "Foo");
    expect(foo.extends?.sort()).toEqual(["Bar", "Baz"].sort());
  });

  it("an unnameable extends expression (a call) is dropped, never guessed", async () => {
    const parsed = await parseOk(
      "typescript",
      `class Foo extends mixin(Base) {}`,
    );
    const foo = byName(parsed.symbols, "Foo");
    expect(foo.extends).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sub-task 2.5 — parse-failure policy and the entry point
// ---------------------------------------------------------------------------

describe("isTrustworthyParse", () => {
  it("zero errors in a non-empty tree is trustworthy", () => {
    expect(isTrustworthyParse(0, 100)).toBe(true);
  });

  it("errors right at the tolerance ratio are still trustworthy", () => {
    expect(isTrustworthyParse(10, 100)).toBe(true);
  });

  it("errors just over the tolerance ratio are not trustworthy", () => {
    expect(isTrustworthyParse(11, 100)).toBe(false);
  });

  it("an empty tree (zero nodes) is trustworthy only with zero errors", () => {
    expect(isTrustworthyParse(0, 0)).toBe(true);
  });
});

describe("parseFile — soft failure and refusal policy", () => {
  it("a well-formed file parses OK with zero parseErrors", async () => {
    const parsed = await parseOk(
      "typescript",
      `export function foo() { return 1; }`,
    );
    expect(parsed.parseState).toBe("OK");
    expect(parsed.parseErrors).toBe(0);
  });

  it("a deliberately malformed file never throws — it returns FAILED with a positive parseErrors count, not an empty-looking OK result", async () => {
    const broken =
      "function foo( {\n  this is not valid syntax at all !!! ###\n  return 1\n";
    const parsed = await parseOk("typescript", broken);
    expect(parsed.parseState).toBe("FAILED");
    expect(parsed.parseErrors).toBeGreaterThan(0);
  });

  it("an empty file parses OK with no symbols — distinct from a refusal", async () => {
    const parsed = await parseOk("typescript", "");
    expect(parsed.parseState).toBe("OK");
    expect(parsed.symbols).toEqual([]);
  });

  it("a comments-only file parses OK with no symbols", async () => {
    const parsed = await parseOk(
      "typescript",
      "// just a comment\n/* and another */\n",
    );
    expect(parsed.parseState).toBe("OK");
    expect(parsed.symbols).toEqual([]);
  });

  it("content over the parser pool's size cap is a typed CONTENT_TOO_LARGE refusal, not a throw", async () => {
    const huge = "a".repeat(MAX_PARSE_CONTENT_BYTES + 1);
    const result = await parseFile("huge.ts", "typescript", huge);
    expect(isParseRefusal(result)).toBe(true);
    if (isParseRefusal(result)) expect(result.reason).toBe("CONTENT_TOO_LARGE");
  });

  it("an unsupported/unrecognized language is a typed UNSUPPORTED_LANGUAGE refusal, distinguishable from an empty parse", async () => {
    const result = await parseFile("README.md", null, "# hello");
    expect(isParseRefusal(result)).toBe(true);
    if (isParseRefusal(result))
      expect(result.reason).toBe("UNSUPPORTED_LANGUAGE");
  });

  it("a refusal and a successful empty parse are never confused by isParseRefusal", async () => {
    const emptyOk = await parseFile("empty.ts", "typescript", "");
    expect(isParseRefusal(emptyOk)).toBe(false);
  });
});
