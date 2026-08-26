import { Query } from "web-tree-sitter";
import { afterAll, describe, expect, it } from "vitest";
import { disposeAll, withParsedTree } from "./parser-pool.js";
import { JAVASCRIPT_QUERY, TSX_QUERY, TYPESCRIPT_QUERY } from "./queries.js";

afterAll(async () => {
  await disposeAll();
});

/** Runs `queryText` against `source` parsed as `language`, returning a per-capture-name
 * count map. Constructing and deleting the Query inside the withParsedTree callback
 * keeps this test file's usage identical to how a real caller would use both modules
 * together — the query never outlives the tree it ran against. */
async function captureCounts(
  language: "typescript" | "tsx" | "javascript",
  queryText: string,
  source: string,
): Promise<Record<string, number>> {
  return withParsedTree(language, source, (tree) => {
    const query = new Query(tree.language, queryText);
    try {
      const counts: Record<string, number> = {};
      for (const capture of query.captures(tree.rootNode)) {
        counts[capture.name] = (counts[capture.name] ?? 0) + 1;
      }
      return counts;
    } finally {
      query.delete();
    }
  });
}

const TS_SAMPLE = `
import Foo from "./foo";
import { Bar, Baz as Qux } from "./bar";
import * as ns from "./ns";
import type { OnlyType } from "./types";
import "./side-effect";
const dyn = import("./dynamic");
const req = require("./cjs");

export default function defaultFn() {}
export function namedFn() {}
export const namedConst = 1;
export { namedFn as aliasedFn };
export * from "./re-export";
export * as reNs from "./ns-export";
export interface ExportedInterface {}
export class ExportedClass {}
export type ExportedAlias = { a: number };
export enum ExportedEnum { A, B }

function plainFn(a: number, b: string): boolean { return true; }
const arrowConst = (x: number): number => x + 1;
const functionExprConst = function () { return 1; };
export class MyClass extends BaseClass implements IFoo, IBar {
  method(a: number): void {}
}
interface MyInterface extends OtherInterface {
  prop: string;
}
type MyAlias = { a: number };
enum MyEnum { A, B, C }
abstract class AbstractBase {
  abstract doThing(): void;
}
import { type OnlyTypeSpecifier, namedConst as importedAliasUnused } from "./types-2";
export = MyClass;

const helperConst = 42;
export default helperConst;

foo();
obj.method();
obj.nested.method();
`;

const JS_SAMPLE = `
import Foo from "./foo";
import { Bar, Baz as Qux } from "./bar";
import * as ns from "./ns";
function add(a, b) { return a + b; }
const arrow = (x) => x + 1;
class Animal {
  speak() {}
}
export default add;
export function named() {}
export { named as aliasedNamed };
export * from "./re-export";
export * as reNs from "./ns-export";
const req = require("./cjs");
const dyn = import("./dynamic");
foo();
obj.method();
`;

const TSX_SAMPLE = `
function Greeting({ name }) {
  return <div className="a"><Nested prop={1} /></div>;
}
const Comp = () => <Foo.Bar />;
`;

const JAVASCRIPT_QUERY_CAPTURE_NAMES = [
  "import.source",
  "import.node",
  "import.default",
  "import.namespace",
  "import.named.name",
  "import.named.alias",
  "import.require.fn",
  "import.require.source",
  "import.require.node",
  "import.dynamic.source",
  "import.dynamic.node",
  "export.default.node",
  "export.default.value",
  "export.name",
  "export.node",
  "export.named.name",
  "export.named.alias",
  "export.star.source",
  "export.star.node",
  "export.namespace.alias",
  "export.namespace.source",
  "export.namespace.node",
  "symbol.function.name",
  "symbol.function.node",
  "symbol.arrow.name",
  "symbol.arrow.node",
  "symbol.class.name",
  "symbol.class.node",
  "symbol.method.name",
  "symbol.method.node",
  "call.name",
  "call.node",
  "call.receiver",
];

const TYPESCRIPT_ONLY_CAPTURE_NAMES = [
  "import.typeOnly.node",
  "symbol.interface.name",
  "symbol.interface.node",
  "symbol.typeAlias.name",
  "symbol.typeAlias.node",
  "symbol.enum.name",
  "symbol.enum.node",
  "heritage.extends",
  "heritage.implements",
  "heritage.interfaceExtends",
  // Prompt 2 additions (see queries.ts's own header for what each covers).
  "import.named.typeOnly.name",
  "export.equals.name",
  "export.equals.node",
];

const TSX_ONLY_CAPTURE_NAMES = ["jsx.element.name", "jsx.selfClosing.name"];

describe("JAVASCRIPT_QUERY", () => {
  it("compiles against the javascript grammar", async () => {
    await expect(captureCounts("javascript", JAVASCRIPT_QUERY, JS_SAMPLE)).resolves.toBeTruthy();
  });

  it.each(JAVASCRIPT_QUERY_CAPTURE_NAMES)("produces a non-empty match set for %s against a representative JS snippet", async (name) => {
    const counts = await captureCounts("javascript", JAVASCRIPT_QUERY, JS_SAMPLE);
    expect(counts[name]).toBeGreaterThan(0);
  });
});

describe("TYPESCRIPT_QUERY", () => {
  it.each([...JAVASCRIPT_QUERY_CAPTURE_NAMES, ...TYPESCRIPT_ONLY_CAPTURE_NAMES])(
    "produces a non-empty match set for %s against a representative TS snippet",
    async (name) => {
      const counts = await captureCounts("typescript", TYPESCRIPT_QUERY, TS_SAMPLE);
      expect(counts[name]).toBeGreaterThan(0);
    },
  );
});

describe("TSX_QUERY", () => {
  it.each([...JAVASCRIPT_QUERY_CAPTURE_NAMES, ...TYPESCRIPT_ONLY_CAPTURE_NAMES, ...TSX_ONLY_CAPTURE_NAMES])(
    "produces a non-empty match set for %s against a representative TSX snippet",
    async (name) => {
      const counts = await captureCounts("tsx", TSX_QUERY, TS_SAMPLE + TSX_SAMPLE);
      expect(counts[name]).toBeGreaterThan(0);
    },
  );

  it("JAVASCRIPT_QUERY's type-only-import pattern is absent — the plain JS grammar has no 'type' node at all", () => {
    // A regression guard for the specific failure this module's header comment
    // describes: placing TYPESCRIPT_QUERY's `"type"` literal pattern into the shared
    // base fails query *compilation* under the javascript grammar, not just matching.
    expect(JAVASCRIPT_QUERY).not.toContain('"type"');
  });
});
