import type { Node, QueryMatch, Tree } from "web-tree-sitter";
import { Query } from "web-tree-sitter";
import type { SymbolKind } from "@repo/shared";
import {
  ContentTooLargeError,
  getParseErrorInfo,
  withParsedTree,
  type ParserLanguage,
} from "../tree-sitter/parser-pool.js";
import {
  JAVASCRIPT_QUERY,
  TSX_QUERY,
  TYPESCRIPT_QUERY,
} from "../tree-sitter/queries.js";
import type {
  ParsedCall,
  ParsedExport,
  ParsedFile,
  ParsedImport,
  ParsedSymbol,
} from "../parsed-file.types.js";

/**
 * Prompt 2's adapter: runs `queries.ts` against a tree from `parser-pool.ts` and
 * normalizes the raw captures into a {@link ParsedFile} — the single entry point is
 * {@link parseFile}. One adapter covers all three languages (`typescript`/`tsx`/
 * `javascript`); the differences between them are grammar selection
 * ({@link LANGUAGE_QUERY}) and a handful of TS/TSX-only constructs the query module
 * already scopes correctly (`abstract_class_declaration`, JSX heuristics), not three
 * separate extraction pipelines.
 *
 * ## Deliberate false-negative bias (docs/decisions/phase-03-log.md's own precedent)
 *
 * A missing symbol/import/export/call is recoverable — the file stays text-indexed for
 * Phase 05's semantic search regardless. A *wrong* one silently poisons the graph and
 * every review that reads it. Every heuristic in this file states its bias explicitly at
 * the point it is applied, and every ambiguous case documented below resolves toward
 * "emit nothing" rather than "guess."
 *
 * ## `query.matches()`, not `query.captures()`, is the primary data source
 *
 * `queries.ts` groups related captures (a named import's `name`+`alias`, a member call's
 * `name`+`receiver`) *within a single pattern*, and `Query#matches()` is the only API
 * that preserves that grouping — `Query#captures()` returns one flat, interleaved
 * sequence with no reliable way to tell which `name` capture belongs with which `alias`
 * capture when multiple specifiers exist in one statement. `flatByName` (below)
 * reconstructs the flat-by-capture-name view for the many call sites here that only need
 * "every node captured as X, regardless of which match produced it" and don't care about
 * pairing (e.g. `import.source`, `heritage.extends`).
 *
 * Patterns in `queries.ts` are independent top-level patterns even when one is nested
 * inside what another matches (e.g. `import_statement`'s own pattern and
 * `import_clause`'s default-binding pattern are *two separate matches* for the same
 * `import Foo from "./m"` statement) — so cross-pattern correlation (assembling one
 * `ParsedImport` per statement from up to four independent capture sources) is still done
 * by walking to a shared ancestor (`findAncestorOfType`), not by match grouping.
 */

// ---------------------------------------------------------------------------
// Bounded-length constants — a database row / prompt context must never be blown up by a
// pathological signature or doc comment (a 10,000-character generic signature, say).
// ---------------------------------------------------------------------------

/** ~4-6 lines of a typical wrapped signature. Long enough to be useful context, short
 * enough that a deeply generic or overloaded signature can never blow up a row. */
export const MAX_SIGNATURE_LENGTH = 500;

/** A generous JSDoc block. Bounds the pathological case (a doc comment someone pasted an
 * entire changelog into) without truncating any doc comment a human would actually write. */
export const MAX_DOC_COMMENT_LENGTH = 2000;

/**
 * `errorNodeCount / totalNodeCount` above this ratio marks a parse untrustworthy
 * (`parseState="FAILED"`) rather than `"OK"`. A ratio, not an absolute count
 * (`plan.md`'s own framing task 2.5 poses): tree-sitter recovers gracefully from a small,
 * local syntax mistake (a missing semicolon might produce one or two ERROR nodes in a
 * file with thousands of nodes total) — that file's extracted symbols are still mostly
 * trustworthy. A file where more than 1 in 10 nodes is a synthetic ERROR node indicates
 * something structurally wrong at file scope (truncated mid-statement, wrong grammar
 * entirely, binary content that slipped past Phase 03's classifier) — at that point,
 * whatever symbols were still extracted are more likely to be artifacts of error recovery
 * than real declarations, and the whole file's worth of extraction is not worth trusting
 * for the knowledge graph (the file stays text-indexed regardless; see this module's
 * header on the false-negative bias this exists to protect).
 */
export const PARSE_ERROR_TOLERANCE_RATIO = 0.1;

// ---------------------------------------------------------------------------
// Query selection
// ---------------------------------------------------------------------------

const LANGUAGE_QUERY: Readonly<Record<ParserLanguage, string>> = {
  typescript: TYPESCRIPT_QUERY,
  tsx: TSX_QUERY,
  javascript: JAVASCRIPT_QUERY,
};

// ---------------------------------------------------------------------------
// Small tree helpers
// ---------------------------------------------------------------------------

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

function stripQuotes(text: string): string {
  const quoteChars = ['"', "'", "`"];
  if (
    text.length >= 2 &&
    quoteChars.includes(text.charAt(0)) &&
    text.charAt(text.length - 1) === text.charAt(0)
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function findAncestorOfType(node: Node, types: string | string[]): Node | null {
  const typeSet = new Set(Array.isArray(types) ? types : [types]);
  let current = node.parent;
  while (current) {
    if (typeSet.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

function captureIn(match: QueryMatch, name: string): Node | undefined {
  return match.captures.find((c) => c.name === name)?.node;
}

/** Reconstructs a flat, by-capture-name view from `query.matches()` — see this module's
 * header for why matches(), not captures(), is the primary data source. */
function flatByName(matches: QueryMatch[]): Map<string, Node[]> {
  const map = new Map<string, Node[]>();
  for (const match of matches) {
    for (const capture of match.captures) {
      const existing = map.get(capture.name);
      if (existing) existing.push(capture.node);
      else map.set(capture.name, [capture.node]);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Doc comments and decorators — leading trivia
// ---------------------------------------------------------------------------

/**
 * Strips comment delimiters and, for a block comment, each line's leading `*` — JSDoc's
 * own convention. A doc comment made of several consecutive `//` line comments (each a
 * *separate* sibling `comment` node in this grammar, unlike one `/** *\/` block) only has
 * its single immediately-preceding line captured, not the whole run — a documented,
 * deliberate scope limit rather than an oversight; see {@link collectLeadingTrivia}.
 */
function stripDocComment(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("/*")) {
    text = text.replace(/^\/\*+/, "").replace(/\*+\/$/, "");
    text = text
      .split("\n")
      .map((line) => line.trim().replace(/^\*/, "").trim())
      .join("\n")
      .trim();
  } else if (text.startsWith("//")) {
    text = text.replace(/^\/\/\s?/, "").trim();
  }
  return text;
}

/**
 * Climbs from a symbol's own declaration node to the outermost node that still
 * *represents that one declaration as a statement* — through `const`/`let` wrapping
 * (`variable_declarator` → `lexical_declaration`) and through `export` wrapping
 * (→ `export_statement`) — so that leading-trivia search (below) looks at the right
 * sibling list. Without this, `export const foo = () => {}`'s doc comment (which precedes
 * the `export_statement`, not the inner `variable_declarator`) would never be found.
 */
function getStatementAnchor(node: Node): Node {
  let anchor = node;
  const wrapper = anchor.parent;
  if (
    wrapper &&
    (wrapper.type === "lexical_declaration" ||
      wrapper.type === "variable_declaration")
  ) {
    anchor = wrapper;
  }
  const exportWrapper = anchor.parent;
  if (exportWrapper && exportWrapper.type === "export_statement") {
    anchor = exportWrapper;
  }
  return anchor;
}

interface LeadingTrivia {
  startLine: number;
  docComment?: string;
}

/**
 * Walks back through preceding `decorator` and `comment` siblings of `anchor`, extending
 * the symbol's `startLine` to cover them. **Decision: symbol ranges include the leading
 * doc comment and any decorators** — Phase 05 anchors chunk boundaries to these ranges,
 * and a chunk that starts mid-doc-comment (the doc comment left dangling in the *previous*
 * chunk) reads badly to a model; including it keeps a symbol's chunk self-contained.
 * Decorators are a field on `class_declaration` itself in this grammar (so a decorated
 * class's own `startPosition` already includes them with no extra work here) but a
 * *sibling* of `method_definition` inside `class_body` (confirmed empirically — see
 * docs/decisions/phase-04-log.md) — this function is what makes both cases behave the
 * same from the adapter's point of view.
 */
/** A blank source line between a comment and what follows is the conventional signal
 * (JSDoc tooling, ESLint's `jsdoc` rules) that the comment is a standalone remark, not
 * documentation for the next declaration — `current` starting more than one row after
 * `prev` ends means at least one fully blank line separates them. Without this check, an
 * unrelated comment several lines above a declaration (with ordinary code, or nothing at
 * all, in between) would still be swallowed into that declaration's range as if it were
 * its doc comment — caught by this prompt's own golden-file test (a fixture with an
 * incidental `// line N` comment separated from the next declaration by a blank line). */
function isImmediatelyAdjacent(prev: Node, current: Node): boolean {
  return current.startPosition.row - prev.endPosition.row <= 1;
}

function collectLeadingTrivia(anchor: Node): LeadingTrivia {
  let startNode = anchor;
  let docComment: string | undefined;
  let current = anchor;
  for (;;) {
    const prev = current.previousSibling;
    if (!prev || !isImmediatelyAdjacent(prev, current)) break;
    if (prev.type === "decorator") {
      startNode = prev;
      current = prev;
      continue;
    }
    if (prev.type === "comment") {
      docComment = truncate(stripDocComment(prev.text), MAX_DOC_COMMENT_LENGTH);
      startNode = prev;
      break;
    }
    break;
  }
  return { startLine: startNode.startPosition.row + 1, docComment };
}

// ---------------------------------------------------------------------------
// Signature — the declaration text without its body
// ---------------------------------------------------------------------------

/**
 * `node`'s own `body` field, if it has one directly (function/class/method/interface/
 * enum declarations all do); otherwise — the `variable_declarator` case for an
 * arrow-function/function-expression-const symbol, whose *own* fields are just
 * `name`/`value` — reaches one level into `value` to find that inner function's body.
 * Falls back to the whole node's end (a type alias's RHS, an abstract method signature
 * with no body at all) — bounded by {@link MAX_SIGNATURE_LENGTH} regardless, so an
 * unbounded RHS can never blow up the stored signature.
 */
function resolveBodyBoundaryIndex(node: Node): number {
  const body = node.childForFieldName("body");
  if (body) return body.startIndex;
  const value = node.childForFieldName("value");
  if (value) {
    const innerBody = value.childForFieldName("body");
    if (innerBody) return innerBody.startIndex;
  }
  return node.endIndex;
}

function getSignatureText(node: Node, sourceText: string): string {
  const boundary = resolveBodyBoundaryIndex(node);
  const raw = sourceText.slice(node.startIndex, boundary).trim();
  return truncate(raw, MAX_SIGNATURE_LENGTH);
}

// ---------------------------------------------------------------------------
// export_statement helpers
// ---------------------------------------------------------------------------

/** The literal `default` token is a positional (unnamed) child, not a field — this checks
 * for its presence directly rather than relying on which field shape matched. */
function isDefaultExportStatement(stmt: Node): boolean {
  for (let i = 0; i < stmt.childCount; i++) {
    const child = stmt.child(i);
    if (child && !child.isNamed && child.text === "default") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

interface ImportStatementAccumulator {
  statementNode: Node;
  source?: Node;
  defaultName?: Node;
  namespaceName?: Node;
  named: { local: string; typeOnly: boolean }[];
  wholeStatementTypeOnly: boolean;
}

/**
 * Assembles one {@link ParsedImport} per `import_statement`, correlating up to four
 * independent query patterns (statement+source, default binding, namespace binding,
 * named specifiers) by walking each capture to its enclosing `import_statement` — see
 * this module's header for why these are independent matches rather than one grouped
 * match. `require(...)` and dynamic `import(...)` are unrelated `call_expression`
 * patterns with no `import_statement` ancestor at all, handled separately at the end.
 *
 * **Mixed per-specifier type-only imports** (`import { type Foo, Bar } from "./m"`):
 * `ParsedImport` (Prompt 1's contract) has one `isTypeOnly` flag per entry, not one per
 * named specifier, so a statement mixing type-only and value specifiers is represented as
 * **two** `ParsedImport` entries sharing the same `specifier`/`line` — one
 * `isTypeOnly: true` covering just the type-only names, one `isTypeOnly: false` covering
 * the rest (and carrying `default`/`namespace`, which can never be marked type-only
 * per-specifier). A statement that is entirely type-only (or all-value) still produces
 * exactly one entry, as the common case.
 */
function extractImports(
  matches: QueryMatch[],
  flat: Map<string, Node[]>,
): ParsedImport[] {
  const byStatement = new Map<number, ImportStatementAccumulator>();

  function ensure(stmt: Node): ImportStatementAccumulator {
    const existing = byStatement.get(stmt.startIndex);
    if (existing) return existing;
    const created: ImportStatementAccumulator = {
      statementNode: stmt,
      named: [],
      wholeStatementTypeOnly: false,
    };
    byStatement.set(stmt.startIndex, created);
    return created;
  }

  for (const node of flat.get("import.node") ?? []) ensure(node);

  for (const node of flat.get("import.source") ?? []) {
    const stmt = findAncestorOfType(node, "import_statement");
    if (stmt) ensure(stmt).source = node;
  }
  for (const node of flat.get("import.default") ?? []) {
    const stmt = findAncestorOfType(node, "import_statement");
    if (stmt) ensure(stmt).defaultName = node;
  }
  for (const node of flat.get("import.namespace") ?? []) {
    const stmt = findAncestorOfType(node, "import_statement");
    if (stmt) ensure(stmt).namespaceName = node;
  }
  // import.typeOnly.node IS the import_statement itself (see queries.ts).
  for (const node of flat.get("import.typeOnly.node") ?? []) {
    ensure(node).wholeStatementTypeOnly = true;
  }

  const typeOnlySpecifierStarts = new Set(
    (flat.get("import.named.typeOnly.name") ?? []).map((n) => n.startIndex),
  );

  for (const match of matches) {
    const nameNode = captureIn(match, "import.named.name");
    if (!nameNode) continue;
    const stmt = findAncestorOfType(nameNode, "import_statement");
    if (!stmt) continue;
    const aliasNode = captureIn(match, "import.named.alias");
    const local = aliasNode ? aliasNode.text : nameNode.text;
    ensure(stmt).named.push({
      local,
      typeOnly: typeOnlySpecifierStarts.has(nameNode.startIndex),
    });
  }

  const imports: ParsedImport[] = [];
  for (const acc of byStatement.values()) {
    if (!acc.source) continue; // every real import_statement has one; structurally unreachable otherwise
    const specifier = stripQuotes(acc.source.text);
    const line = lineOf(acc.statementNode);
    const mixedTypeOnly =
      !acc.wholeStatementTypeOnly &&
      acc.named.some((n) => n.typeOnly) &&
      acc.named.some((n) => !n.typeOnly);

    if (mixedTypeOnly) {
      const typeOnlyLocals = acc.named
        .filter((n) => n.typeOnly)
        .map((n) => n.local);
      const valueLocals = acc.named
        .filter((n) => !n.typeOnly)
        .map((n) => n.local);
      imports.push({
        specifier,
        named: typeOnlyLocals,
        line,
        isTypeOnly: true,
        syntax: "static",
      });
      imports.push({
        specifier,
        named: valueLocals,
        default: acc.defaultName?.text,
        namespace: acc.namespaceName?.text,
        line,
        isTypeOnly: false,
        syntax: "static",
      });
      continue;
    }

    const allNamedTypeOnly =
      acc.named.length > 0 && acc.named.every((n) => n.typeOnly);
    imports.push({
      specifier,
      named: acc.named.map((n) => n.local),
      default: acc.defaultName?.text,
      namespace: acc.namespaceName?.text,
      line,
      isTypeOnly: acc.wholeStatementTypeOnly || allNamedTypeOnly,
      syntax: "static",
    });
  }

  // require(...) and dynamic import(...) — independent call_expression patterns, never
  // grouped under an import_statement. A non-literal dynamic import (`import(somePath)`)
  // never reaches here at all: queries.ts's pattern requires a string-literal argument,
  // so it produces no capture — "record nothing" rather than fabricate a specifier.
  for (const match of matches) {
    const reqNode = captureIn(match, "import.require.node");
    const reqSource = captureIn(match, "import.require.source");
    if (reqNode && reqSource) {
      imports.push({
        specifier: stripQuotes(reqSource.text),
        named: [],
        line: lineOf(reqNode),
        isTypeOnly: false,
        syntax: "require",
      });
    }
    const dynNode = captureIn(match, "import.dynamic.node");
    const dynSource = captureIn(match, "import.dynamic.source");
    if (dynNode && dynSource) {
      imports.push({
        specifier: stripQuotes(dynSource.text),
        named: [],
        line: lineOf(dynNode),
        isTypeOnly: false,
        syntax: "dynamic",
      });
    }
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

interface ExportExtractionResult {
  exports: ParsedExport[];
  /** Local (pre-alias) names this file exports directly — used to correlate a symbol
   * declared as `function foo() {}` with a *later* `export { foo }` (§2.3's "easy to
   * miss" case). Re-exported names (`export { a } from "./m"`) are deliberately excluded
   * — `a` is never a local binding in *this* file, so it must never mark some unrelated
   * same-named local symbol as exported. */
  exportedLocalNames: ReadonlySet<string>;
  /** One synthetic `ParsedImport` per re-exporting statement — see this function's own
   * "dual nature" comment below. */
  reExportImports: ParsedImport[];
}

/**
 * **Dual nature of a re-export**: `export { a } from "./m"`, `export * from "./m"`, and
 * `export * as ns from "./m"` are simultaneously an import (this file gains a dependency
 * edge on `"./m"`) and an export (re-exposing whatever `"./m"` exports) — but none of
 * them parse as an `import_statement` at all; they are purely `export_statement` shapes
 * with a `source` field. The export side is captured directly by `queries.ts`'s
 * export.star/namespace/named patterns; the import side has no query pattern of its own
 * and is synthesized here, once per re-exporting statement, with an empty `named: []` —
 * a re-export creates no local binding usable elsewhere in this file (nothing to put in
 * `named`), but the import-resolver (Prompt 3) still needs the file-level edge itself to
 * bucket `"./m"` as RESOLVED/EXTERNAL/UNRESOLVED.
 */
function extractExports(
  matches: QueryMatch[],
  flat: Map<string, Node[]>,
): ExportExtractionResult {
  const exports: ParsedExport[] = [];
  const exportedLocalNames = new Set<string>();
  const reExportStatements = new Map<
    number,
    { node: Node; specifier: string }
  >();
  const handledDefaultStatementStarts = new Set<number>();

  // Declaration-form exports: export function/class/interface/type-alias/enum/const foo.
  // A single export.name capture (per queries.ts) also covers `export default function
  // foo() {}` — isDefaultExportStatement below is what distinguishes the two.
  for (const match of matches) {
    const nameNode = captureIn(match, "export.name");
    if (!nameNode) continue;
    const stmt = findAncestorOfType(nameNode, "export_statement");
    if (!stmt) continue;
    const isDefault = isDefaultExportStatement(stmt);
    exports.push({ name: nameNode.text, isDefault, line: lineOf(stmt) });
    exportedLocalNames.add(nameNode.text);
    if (isDefault) handledDefaultStatementStarts.add(stmt.startIndex);
  }

  // Default exports with no declared name reachable above: a bare-expression default
  // (`export default helperConst;`, `export default () => {}`) or an anonymous default
  // declaration (`export default class {}`). If the value is itself a plain identifier,
  // that identifier *is* a real, sourced name (not a guess) — used as-is; anything else
  // (an arrow function, an anonymous class) gets the empty-name contract Prompt 1's own
  // ParsedExport.name doc comment defines for "no local name available".
  for (const match of matches) {
    const defaultNode = captureIn(match, "export.default.node");
    if (!defaultNode) continue;
    if (handledDefaultStatementStarts.has(defaultNode.startIndex)) continue;
    handledDefaultStatementStarts.add(defaultNode.startIndex);
    const valueNode = captureIn(match, "export.default.value");
    const name =
      valueNode && valueNode.type === "identifier" ? valueNode.text : "";
    exports.push({ name, isDefault: true, line: lineOf(defaultNode) });
  }

  // Named specifiers: export { a, b as c } [from "..."] — including the re-export shape.
  for (const match of matches) {
    const nameNode = captureIn(match, "export.named.name");
    if (!nameNode) continue;
    const stmt = findAncestorOfType(nameNode, "export_statement");
    if (!stmt) continue;
    const aliasNode = captureIn(match, "export.named.alias");
    const publicName = aliasNode ? aliasNode.text : nameNode.text;
    const sourceField = stmt.childForFieldName("source");
    if (sourceField) {
      const specifier = stripQuotes(sourceField.text);
      exports.push({
        name: publicName,
        isDefault: false,
        line: lineOf(nameNode),
        reExportFrom: specifier,
      });
      reExportStatements.set(stmt.startIndex, { node: stmt, specifier });
    } else {
      exports.push({
        name: publicName,
        isDefault: false,
        line: lineOf(nameNode),
      });
      exportedLocalNames.add(nameNode.text);
    }
  }

  // export * from "./m"
  for (const node of flat.get("export.star.node") ?? []) {
    const sourceField = node.childForFieldName("source");
    const specifier = sourceField ? stripQuotes(sourceField.text) : "";
    exports.push({
      name: "",
      isDefault: false,
      line: lineOf(node),
      reExportFrom: specifier,
    });
    if (specifier) reExportStatements.set(node.startIndex, { node, specifier });
  }

  // export * as ns from "./m"
  for (const match of matches) {
    const nsNode = captureIn(match, "export.namespace.node");
    if (!nsNode) continue;
    const aliasNode = captureIn(match, "export.namespace.alias");
    const sourceNode = captureIn(match, "export.namespace.source");
    const specifier = sourceNode ? stripQuotes(sourceNode.text) : "";
    exports.push({
      name: aliasNode ? aliasNode.text : "",
      isDefault: false,
      line: lineOf(nsNode),
      reExportFrom: specifier,
    });
    if (specifier)
      reExportStatements.set(nsNode.startIndex, { node: nsNode, specifier });
  }

  // export = Foo; — TypeScript's CommonJS-interop form. Not a re-export (no `from`
  // clause, nothing to synthesize an import for) and not `isDefault` (a distinct,
  // TS-only construct — see queries.ts's own header for why it needs its own pattern).
  for (const match of matches) {
    const eqNameNode = captureIn(match, "export.equals.name");
    const eqStmtNode = captureIn(match, "export.equals.node");
    if (eqNameNode && eqStmtNode) {
      exports.push({
        name: eqNameNode.text,
        isDefault: false,
        line: lineOf(eqStmtNode),
      });
    }
  }

  const reExportImports: ParsedImport[] = [...reExportStatements.values()].map(
    ({ node, specifier }) => ({
      specifier,
      named: [],
      line: lineOf(node),
      isTypeOnly: false,
      syntax: "static",
    }),
  );

  return { exports, exportedLocalNames, reExportImports };
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

interface InternalSymbolRecord {
  symbol: ParsedSymbol;
  /** The node used for range/signature/export-correlation — the outer node for an
   * arrow/function-expression-const symbol (its `variable_declarator`), the declaration
   * node itself for everything else. */
  declNode: Node;
  /** The node whose body subtree is examined for complexity and JSX detection, and whose
   * range calls are attributed against — the actual `arrow_function`/`function_expression`
   * for a const-bound symbol, `declNode` itself otherwise. */
  callableNode: Node;
}

/**
 * A symbol candidate found nested inside a function/method body, or inside an
 * object-literal (a shorthand method or a property whose value is an
 * arrow/function-expression), is not emitted as a top-level symbol at all — **decision,
 * not oversight**: a closure captured this way is recoverable via the file's text/
 * semantic index (Phase 05) but is not modeled as its own graph node this phase (§2.3's
 * own framing: "nothing" is a defensible answer). One ancestor walk implements both
 * exclusion rules uniformly, because both are really the same rule ("not reachable as a
 * declaration directly under a class/interface/program/export boundary") — a
 * `method_definition` whose parent is `object` (not `class_body`) is exactly as excluded
 * as a `const` declared inside another function's body.
 */
const NESTING_BOUNDARY_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "abstract_method_signature",
  "object",
  "pair",
]);

function isEligibleTopLevelSymbol(declNode: Node): boolean {
  let current = declNode.parent;
  while (current) {
    if (NESTING_BOUNDARY_TYPES.has(current.type)) return false;
    current = current.parent;
  }
  return true;
}

const FUNCTION_LIKE_CAPTURE_KINDS: ReadonlyArray<
  readonly [string, SymbolKind]
> = [
  ["symbol.function", "FUNCTION"],
  ["symbol.class", "CLASS"],
  ["symbol.method", "METHOD"],
  ["symbol.interface", "INTERFACE"],
  ["symbol.typeAlias", "TYPE_ALIAS"],
  ["symbol.enum", "ENUM"],
];

const COMPLEXITY_ELIGIBLE_KINDS = new Set<SymbolKind>([
  "FUNCTION",
  "ARROW_FUNCTION",
  "METHOD",
  "HOOK",
  "REACT_COMPONENT",
]);

/**
 * **React component / hook heuristic — false-positive and false-negative directions
 * stated explicitly, per §2.3's own requirement.**
 *
 * A hook is any `FUNCTION`/`ARROW_FUNCTION` whose name matches `^use[A-Z0-9]` — a
 * same-named-but-unrelated function starting with `use` (`useful`, `user`) is excluded by
 * the required capital/digit after `use`; a real hook that breaks naming convention is a
 * false negative this heuristic accepts (the convention is close to universal in the
 * ecosystem this heuristic targets).
 *
 * A React component requires **both** a PascalCase name **and** a JSX return somewhere
 * in its body — requiring JSX (not PascalCase alone) is the deliberate choice §2.3 calls
 * out: PascalCase alone would misclassify every exported class-like factory function
 * (`function Registry() { return { get, set }; }`). A `.ts`/`.js` file cannot contain
 * JSX at all (confirmed: JSX node types are TSX-grammar-only), so this branch is
 * structurally unreachable outside `language === "tsx"` — stated here rather than left
 * implicit. False negative: a component that returns JSX only through an intermediate
 * variable (`const el = <div/>; return el;`) is still caught, since the JSX subtree
 * search is unconditional on control flow — but a component whose JSX lives behind a
 * dynamically-selected element type with no literal JSX node at all would be missed
 * (rare, and "miss" is the safe direction per this file's bias). False positive: a
 * PascalCase-named factory that happens to return unrelated JSX somewhere deep in its
 * body (e.g. a template-generation helper) would be wrongly classified as a component —
 * accepted as the cost of a name+shape heuristic with no type information.
 */
const HOOK_NAME_PATTERN = /^use[A-Z0-9]/;
const PASCAL_CASE_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
const JSX_NODE_TYPES = [
  "jsx_element",
  "jsx_self_closing_element",
  "jsx_fragment",
];

function classifyFunctionLikeKind(
  baseKind: SymbolKind,
  name: string,
  language: ParserLanguage,
  callableNode: Node,
): SymbolKind {
  if (baseKind !== "FUNCTION" && baseKind !== "ARROW_FUNCTION") return baseKind;
  if (HOOK_NAME_PATTERN.test(name)) return "HOOK";
  if (
    language === "tsx" &&
    PASCAL_CASE_PATTERN.test(name) &&
    callableNode.descendantsOfType(JSX_NODE_TYPES).length > 0
  ) {
    return "REACT_COMPONENT";
  }
  return baseKind;
}

// ---------------------------------------------------------------------------
// Cyclomatic complexity — 1 + one per decision point, counted from the AST
// ---------------------------------------------------------------------------

/**
 * Node types counted as a decision point (`+1` each): `if_statement`, `for_statement`,
 * `for_in_statement` (covers both `for...in` and `for...of` — one grammar node type for
 * both), `while_statement`, `do_statement`, `catch_clause`, `switch_case` (not
 * `switch_default` — the default branch is not itself a decision), `ternary_expression`,
 * and a `binary_expression` whose `operator` field is `&&`/`||`/`??` (confirmed
 * empirically that this grammar exposes `operator` as a real field, letting logical
 * operators be distinguished from arithmetic/comparison ones sharing the same node type —
 * see docs/decisions/phase-04-log.md).
 *
 * Deliberately does **not** descend into a nested callable boundary
 * (`function_declaration`/`function_expression`/`arrow_function`/`method_definition`/
 * `abstract_method_signature`) other than the root itself — an inline callback's branches
 * are not counted toward the enclosing symbol's complexity, and (since inline closures are
 * never emitted as their own symbols either, per {@link isEligibleTopLevelSymbol}) are not
 * counted anywhere. A documented under-count, not a bug: this walk answers "how branchy is
 * this symbol's own direct control flow", not "how branchy is everything reachable from
 * it". The walk is iterative (a `TreeCursor`, never recursion) for the same reason
 * `parser-pool.ts`'s own error-node walk is — repository content is attacker-controlled.
 */
const COMPLEXITY_BOUNDARY_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "abstract_method_signature",
]);
const LOGICAL_OPERATORS = new Set(["&&", "||", "??"]);
const DECISION_NODE_TYPES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "catch_clause",
  "switch_case",
  "ternary_expression",
]);

function computeComplexity(root: Node): number {
  let complexity = 1;
  const cursor = root.walk();
  try {
    let visitedChildren = false;
    for (;;) {
      if (!visitedChildren) {
        const node = cursor.currentNode;
        const isRoot =
          node.startIndex === root.startIndex &&
          node.endIndex === root.endIndex;
        if (!isRoot && COMPLEXITY_BOUNDARY_TYPES.has(node.type)) {
          if (cursor.gotoNextSibling()) {
            visitedChildren = false;
            continue;
          }
          if (!cursor.gotoParent()) break;
          visitedChildren = true;
          continue;
        }
        if (DECISION_NODE_TYPES.has(node.type)) {
          complexity += 1;
        } else if (node.type === "binary_expression") {
          const operator = node.childForFieldName("operator")?.text;
          if (operator && LOGICAL_OPERATORS.has(operator)) complexity += 1;
        }
        if (cursor.gotoFirstChild()) continue;
      }
      if (cursor.gotoNextSibling()) {
        visitedChildren = false;
        continue;
      }
      if (!cursor.gotoParent()) break;
      visitedChildren = true;
    }
  } finally {
    cursor.delete();
  }
  return complexity;
}

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

function extractSymbolRecords(
  matches: QueryMatch[],
  sourceText: string,
  language: ParserLanguage,
  exportedLocalNames: ReadonlySet<string>,
): InternalSymbolRecord[] {
  const records: InternalSymbolRecord[] = [];
  const seenRanges = new Set<string>();

  function addCandidate(
    kind: SymbolKind,
    nameNode: Node,
    declNode: Node,
    callableNode: Node,
  ): void {
    if (!isEligibleTopLevelSymbol(declNode)) return;

    // Defensive dedup — overloaded TS function signatures never reach here at all (the
    // query only matches `function_declaration`, which requires a body; a bodyless
    // `function_signature` overload is a different node type entirely, confirmed
    // empirically), but this guards against any future pattern accidentally double-
    // matching the same declaration.
    const dedupeKey = `${declNode.startIndex.toString()}:${declNode.endIndex.toString()}`;
    if (seenRanges.has(dedupeKey)) return;
    seenRanges.add(dedupeKey);

    const name = nameNode.text;
    const anchor = getStatementAnchor(declNode);
    const trivia = collectLeadingTrivia(anchor);
    const isDirectExport = anchor.type === "export_statement";
    const finalKind = classifyFunctionLikeKind(
      kind,
      name,
      language,
      callableNode,
    );

    const parentClass = findAncestorOfType(declNode, [
      "class_declaration",
      "abstract_class_declaration",
    ]);
    const parentSymbol = parentClass?.childForFieldName("name")?.text;

    const symbol: ParsedSymbol = {
      name,
      kind: finalKind,
      startLine: trivia.startLine,
      endLine: declNode.endPosition.row + 1,
      isExported: isDirectExport || exportedLocalNames.has(name),
      isDefault: isDirectExport && isDefaultExportStatement(anchor),
      signature: getSignatureText(declNode, sourceText),
      docComment: trivia.docComment,
      parentSymbol,
      complexity: COMPLEXITY_ELIGIBLE_KINDS.has(finalKind)
        ? computeComplexity(callableNode)
        : 1,
      calls: [],
    };

    records.push({ symbol, declNode, callableNode });
  }

  for (const match of matches) {
    for (const [key, kind] of FUNCTION_LIKE_CAPTURE_KINDS) {
      const declNode = captureIn(match, `${key}.node`);
      const nameNode = captureIn(match, `${key}.name`);
      if (declNode && nameNode)
        addCandidate(kind, nameNode, declNode, declNode);
    }
    const arrowDeclNode = captureIn(match, "symbol.arrow.node");
    const arrowNameNode = captureIn(match, "symbol.arrow.name");
    if (arrowDeclNode && arrowNameNode) {
      const callableNode =
        arrowDeclNode.childForFieldName("value") ?? arrowDeclNode;
      addCandidate(
        "ARROW_FUNCTION",
        arrowNameNode,
        arrowDeclNode,
        callableNode,
      );
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// Class / interface heritage
// ---------------------------------------------------------------------------

/**
 * Accepts a simple name (`identifier`/`type_identifier`, including through a
 * `generic_type` wrapper — `implements Comparable<Foo>` names `Comparable`) or a
 * dotted-identifier chain with no call in it (`implements ns.IFoo`). Rejects anything
 * else — most notably `class A extends mixin(B) {}`'s `extends_clause` value, which is a
 * `call_expression`, not a name at all: **never guess** a class name out of an arbitrary
 * expression (§2.4's own instruction); such a heritage clause is silently dropped rather
 * than fabricating "mixin" or "B" as the parent.
 */
function extractNameableHeritageTarget(node: Node): string | null {
  if (node.type === "identifier" || node.type === "type_identifier")
    return node.text;
  if (node.type === "generic_type") {
    const nameField = node.childForFieldName("name");
    if (
      nameField &&
      (nameField.type === "identifier" || nameField.type === "type_identifier")
    ) {
      return nameField.text;
    }
    return null;
  }
  if (
    node.type === "nested_type_identifier" ||
    node.type === "member_expression"
  ) {
    return node.text.includes("(") ? null : node.text;
  }
  return null;
}

/**
 * Keyed by `Node#id`, not `startIndex` — a node's `startIndex` frequently *coincides*
 * with an ancestor's (a `program`'s own start equals its first statement's start, which
 * equals that statement's first token's start, and so on down), so two structurally
 * different nodes can share the same start offset. `id` is the one property the library
 * itself documents as unique per node within a tree; using `startIndex` here produced a
 * real bug caught by this prompt's own tests (see docs/decisions/phase-04-log.md, Prompt
 * 2 section) — a module-top-level call was wrongly attributed to the first symbol in the
 * file, because that symbol's declaration node happened to start at the same byte offset
 * as the enclosing `program` node the call's ancestor walk passed through.
 */
function attachHeritage(
  flat: Map<string, Node[]>,
  records: InternalSymbolRecord[],
): void {
  const byDeclId = new Map<number, InternalSymbolRecord>();
  for (const record of records) byDeclId.set(record.declNode.id, record);

  function attach(
    captureName: string,
    ownerTypes: string[],
    field: "extends" | "implements",
  ): void {
    for (const node of flat.get(captureName) ?? []) {
      const owner = findAncestorOfType(node, ownerTypes);
      if (!owner) continue;
      const record = byDeclId.get(owner.id);
      if (!record) continue;
      const target = extractNameableHeritageTarget(node);
      if (!target) continue;
      record.symbol[field] = [...(record.symbol[field] ?? []), target];
    }
  }

  attach(
    "heritage.extends",
    ["class_declaration", "abstract_class_declaration"],
    "extends",
  );
  attach(
    "heritage.implements",
    ["class_declaration", "abstract_class_declaration"],
    "implements",
  );
  attach("heritage.interfaceExtends", ["interface_declaration"], "extends");
}

// ---------------------------------------------------------------------------
// Call sites
// ---------------------------------------------------------------------------

/** `a.b().c()`'s `c()` call has receiver `a.b()`, whose node type is `call_expression` —
 * not a nameable class/instance reference, so it is dropped (§2.4: "no receiver" is
 * defensible, a fabricated one is not). `a.b.c()`'s receiver `a.b` (`member_expression`
 * rooted in identifiers, no call anywhere in it) is kept as raw text, matching Prompt 1's
 * own documented precedent in `parsed-file.types.ts` ("captures the receiver's whole
 * subtree text, not just an identifier") — only a receiver that is *itself* a call is
 * excluded, not every non-identifier shape. */
function isNameableReceiverNode(node: Node): boolean {
  return node.type !== "call_expression";
}

/** See {@link attachHeritage}'s header comment for why this is keyed by `Node#id`, not
 * `startIndex`. */
function findEnclosingRecord(
  node: Node,
  byCallableId: Map<number, InternalSymbolRecord>,
): InternalSymbolRecord | undefined {
  let current = node.parent;
  while (current) {
    const record = byCallableId.get(current.id);
    if (record) return record;
    current = current.parent;
  }
  return undefined;
}

/**
 * Attributes each call to its innermost enclosing *tracked* symbol — walking up through
 * any number of untracked closures (a nested helper function that was itself excluded by
 * {@link isEligibleTopLevelSymbol}) until a tracked one is found, or the file's top is
 * reached with none. **A call reached with no tracked ancestor — whether it is truly at
 * module top level, or nested only inside untracked closures — is dropped, not attributed
 * to some enclosing file-level placeholder.** Dropping is the simpler, safer default
 * (§2.4's own framing); it is a real recall gap in the graph, called out explicitly here
 * and in the report-back rather than silently absorbed.
 *
 * `require(...)`/dynamic `import(...)` call expressions are excluded here even though
 * they structurally also match the generic call pattern — they are already represented
 * as {@link ParsedImport} entries, and including them again as graph `CALLS` edges would
 * only ever resolve against a "require"/"import" symbol name that cannot exist in this
 * repository's own symbol table, pure noise for Prompt 3's resolver.
 *
 * Deduplicates within a symbol by `receiver + name` — a function calling
 * `logger.info()` forty times produces one `ParsedCall`, not forty (§2.4's own example).
 */
function attachCalls(
  matches: QueryMatch[],
  records: InternalSymbolRecord[],
): void {
  const byCallableId = new Map<number, InternalSymbolRecord>();
  for (const record of records)
    byCallableId.set(record.callableNode.id, record);

  const dedupeByRecord = new Map<InternalSymbolRecord, Set<string>>();
  function dedupeSetFor(record: InternalSymbolRecord): Set<string> {
    const existing = dedupeByRecord.get(record);
    if (existing) return existing;
    const created = new Set<string>();
    dedupeByRecord.set(record, created);
    return created;
  }

  for (const match of matches) {
    const callNode = captureIn(match, "call.node");
    const nameNode = captureIn(match, "call.name");
    if (!callNode || !nameNode) continue;

    const functionNode = callNode.childForFieldName("function");
    if (
      functionNode &&
      (functionNode.type === "import" ||
        (functionNode.type === "identifier" && functionNode.text === "require"))
    ) {
      continue;
    }

    const record = findEnclosingRecord(callNode, byCallableId);
    if (!record) continue;

    const receiverNode = captureIn(match, "call.receiver");
    const receiver =
      receiverNode && isNameableReceiverNode(receiverNode)
        ? receiverNode.text
        : undefined;

    const dedupeKey = `${receiver ?? ""} ${nameNode.text}`;
    const dedupeSet = dedupeSetFor(record);
    if (dedupeSet.has(dedupeKey)) continue;
    dedupeSet.add(dedupeKey);

    const call: ParsedCall = {
      name: nameNode.text,
      receiver,
      line: lineOf(callNode),
    };
    record.symbol.calls.push(call);
  }
}

// ---------------------------------------------------------------------------
// Total-node counting — for the parse-error tolerance ratio only
// ---------------------------------------------------------------------------

/**
 * A second, separate iterative walk from `parser-pool.ts`'s own `getParseErrorInfo` —
 * deliberately not merged into that function. `ParsedFile.parseErrors`'s doc comment
 * (Prompt 1) ties its semantics specifically to `getParseErrorInfo`'s error-node count,
 * so that function's contract is left untouched; this adapter computes the *denominator*
 * for {@link isTrustworthyParse}'s ratio itself, paying one extra bounded walk (content is
 * already capped at `MAX_PARSE_CONTENT_BYTES` by `withParsedTree`) rather than widen a
 * committed, already-tested module's return shape for a need specific to this layer.
 */
function countTotalNodes(root: Node): number {
  let count = 0;
  const cursor = root.walk();
  try {
    let visitedChildren = false;
    for (;;) {
      if (!visitedChildren) {
        count += 1;
        if (cursor.gotoFirstChild()) continue;
      }
      if (cursor.gotoNextSibling()) {
        visitedChildren = false;
        continue;
      }
      if (!cursor.gotoParent()) break;
      visitedChildren = true;
    }
  } finally {
    cursor.delete();
  }
  return count;
}

// ---------------------------------------------------------------------------
// The parse-error tolerance predicate — exported so prompt 4's mapping decision is
// testable here, even though ParsedFile.parseState is actually set by parseFile below
// ---------------------------------------------------------------------------

/**
 * Pure predicate over raw counts, not a `ParsedFile` — `ParsedFile.parseErrors`
 * (Prompt 1's contract) stores the error-node count alone, with no accompanying
 * total-node count, so there is nothing to recompute a ratio from *after* the fact from a
 * `ParsedFile` value. `parseFile` below calls this at parse time (when both counts are
 * available from the live tree) to decide `ParsedFile.parseState` directly — reconciling
 * with `parsed-file.types.ts`'s own comment ("the adapter is what enforces the narrower
 * practical range" of `ParseState`) rather than deferring that decision to Prompt 4's
 * graph-builder as this prompt's own sub-task 2.5 text initially suggests; see this
 * prompt's report-back, "Conflicts found", for the full reasoning. Exporting the
 * predicate itself (rather than inlining the ratio check) is what keeps that logic
 * independently testable regardless of which layer ends up calling it.
 */
export function isTrustworthyParse(
  errorNodeCount: number,
  totalNodeCount: number,
): boolean {
  if (totalNodeCount === 0) return errorNodeCount === 0;
  return errorNodeCount / totalNodeCount <= PARSE_ERROR_TOLERANCE_RATIO;
}

// ---------------------------------------------------------------------------
// The public entry point
// ---------------------------------------------------------------------------

/**
 * A clean, typed refusal — distinct from a `ParsedFile` with empty arrays. "Parsed fine,
 * found nothing" and "never attempted" are genuinely different states a caller (Prompt 4)
 * must be able to tell apart (§2.5's own requirement): the former is legitimate
 * (an empty file, a comments-only file); the latter means no `CodeSymbol`/`CodeDependency`
 * work should be attempted for this file at all.
 */
export interface ParseRefusal {
  filePath: string;
  language: ParserLanguage | null;
  refused: true;
  reason: "UNSUPPORTED_LANGUAGE" | "CONTENT_TOO_LARGE";
}

export type ParseFileResult = ParsedFile | ParseRefusal;

export function isParseRefusal(
  result: ParseFileResult,
): result is ParseRefusal {
  return (result as Partial<ParseRefusal>).refused === true;
}

/**
 * Phase 04 (sub-task 4.6 perf finding): compiling a tree-sitter `Query` pattern is
 * significantly more expensive than parsing the handful of lines a typical source file
 * contains — recompiling {@link LANGUAGE_QUERY}'s combined
 * symbols/imports/exports/heritage/calls pattern on every single call to
 * `buildParsedFile` measured at roughly 35-45ms/file against a synthetic 5,000-file
 * fixture (`repository-index-performance.test.ts`), on track to miss this phase's own
 * §15 acceptance criterion ("a 10,000-file repository completes parsing in under 5
 * minutes"). One `Query` object is safe to reuse across every parse for a given
 * language — it is a pure pattern matched against whatever tree `.matches()` is handed,
 * with no per-parse state — exactly the same one-per-language, process-lifetime
 * memoization `parser-pool.ts` already applies to `Parser`/`Language`. Never `.delete()`d
 * for the same reason those two are not: it needs to outlive every individual parse, not
 * just one.
 */
const queryCache = new Map<ParserLanguage, Query>();

function getQuery(language: ParserLanguage, tree: Tree): Query {
  const existing = queryCache.get(language);
  if (existing) return existing;
  const query = new Query(tree.language, LANGUAGE_QUERY[language]);
  queryCache.set(language, query);
  return query;
}

function buildParsedFile(
  filePath: string,
  language: ParserLanguage,
  sourceText: string,
  tree: Tree,
): ParsedFile {
  const rootNode = tree.rootNode;
  const query = getQuery(language, tree);
  const matches = query.matches(rootNode);
  const flat = flatByName(matches);

  const imports = extractImports(matches, flat);
  const { exports, exportedLocalNames, reExportImports } = extractExports(
    matches,
    flat,
  );
  const records = extractSymbolRecords(
    matches,
    sourceText,
    language,
    exportedLocalNames,
  );
  attachHeritage(flat, records);
  attachCalls(matches, records);

  const { errorNodeCount } = getParseErrorInfo(tree);
  const totalNodeCount = countTotalNodes(rootNode);

  return {
    filePath,
    language,
    imports: [...imports, ...reExportImports],
    exports,
    symbols: records.map((record) => record.symbol),
    parseErrors: errorNodeCount,
    parseState: isTrustworthyParse(errorNodeCount, totalNodeCount)
      ? "OK"
      : "FAILED",
  };
}

/**
 * The single narrow public function this module exposes. Never throws for malformed,
 * truncated, empty, comments-only, or binary-ish input — `web-tree-sitter` itself never
 * throws on malformed text (`parser-pool.ts`'s own contract; it produces `ERROR` nodes
 * instead), so the only exception this function ever has to convert into a typed result
 * is {@link ContentTooLargeError} from `withParsedTree`'s pre-parse size guard. Any other
 * exception is a genuine bug and is deliberately allowed to propagate rather than being
 * swallowed into a false "parsed fine" result.
 *
 * `language: null` (the caller's `selectLanguage` returned nothing — an unrecognized
 * extension) is accepted directly, rather than requiring every caller to branch before
 * calling in, so that "this file was never eligible for parsing at all" is always a
 * `ParseRefusal` this module itself produces, not a convention scattered across callers.
 *
 * Debug-level logging only, deliberately absent from this module entirely: this function
 * runs in a hot loop over thousands of files (§2.5's own instruction against per-file
 * `info`-level logging); aggregate parse-failure counts are Prompt 4's batch-logger's job
 * (spec §20), not this layer's.
 */
export async function parseFile(
  filePath: string,
  language: ParserLanguage | null,
  source: string,
): Promise<ParseFileResult> {
  if (language === null) {
    return {
      filePath,
      language,
      refused: true,
      reason: "UNSUPPORTED_LANGUAGE",
    };
  }

  try {
    return await withParsedTree(language, source, (tree) =>
      buildParsedFile(filePath, language, source, tree),
    );
  } catch (error) {
    if (error instanceof ContentTooLargeError) {
      return { filePath, language, refused: true, reason: "CONTENT_TOO_LARGE" };
    }
    throw error;
  }
}
