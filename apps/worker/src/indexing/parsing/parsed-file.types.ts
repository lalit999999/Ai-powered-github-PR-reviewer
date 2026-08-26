import type { ParseState, SymbolKind } from "@repo/shared";
import type { ParserLanguage } from "./tree-sitter/parser-pool.js";

/**
 * The contract between the parsing layer (Prompt 2's `adapters/typescript.adapter.ts`,
 * which runs `queries.ts` against a tree from `parser-pool.ts` and normalizes the raw
 * captures into this shape) and the graph layer (Prompts 3–4's `import-resolver.ts` /
 * `call-resolver.ts` / `graph-builder.ts`, which consume it). Declaring the boundary as
 * a types-only module — no logic, no Prisma, no parser-pool imports beyond the
 * {@link ParserLanguage} type — is what makes both sides independently testable: the
 * adapter can be tested against fixture source with no database, and the graph layer can
 * be tested against hand-built `ParsedFile` fixtures with no tree-sitter involved at all.
 *
 * Based on `plan.md` §10.3's own `ParsedFile` sketch, adapted onto this codebase's real
 * types (`SymbolKind`/`ParseState` from `@repo/shared`, not an inline union) plus two
 * deliberate departures from that sketch, each documented at its own field below:
 * {@link ParsedCall} is an object rather than a bare `string`, and {@link ParsedImport}
 * gained `syntax`.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export interface ParsedImport {
  /** Raw, exactly as written in source — resolution (relative/tsconfig-alias/workspace/
   * external/unresolved, `plan.md` §11.2) is `import-resolver.ts`'s job, not this
   * module's; this type only carries what the parse step observed. */
  specifier: string;
  /** Named specifiers, e.g. `{ Bar, Baz as Qux }` → `["Bar", "Baz"]` (the *local* bound
   * name — `Qux`, not `Baz` — is what a caller in this file will actually reference in
   * a call site, so that's what belongs here for call-resolution to key off later). */
  named: string[];
  /** The local name bound by a default import, if any. */
  default?: string;
  /** The local name bound by a namespace import (`import * as ns from "..."`), if any. */
  namespace?: string;
  line: number;
  /** `import type { ... }` — a type-only import contributes nothing to the runtime
   * call/reference graph; the graph-builder (Prompt 4) is expected to skip these when
   * building the pass-2 name index. */
  isTypeOnly: boolean;
  /**
   * Deliberate addition beyond `plan.md` §10.3's sketch, which has no `syntax` field.
   * `require("./x")` and a dynamic `import("./x")` resolve to the same target file as a
   * static `import` statement, but they are not interchangeable for the graph: a
   * `require` call is also, syntactically, a {@link ParsedCall} in whichever symbol
   * contains it (the same `call_expression` node matches both `queries.ts`'s import and
   * call patterns), and a dynamic `import()` is a runtime code-splitting boundary a
   * future phase's bundling-aware analysis may want to treat differently. Conflating all
   * three into one `ParsedImport` shape with no way to tell them apart would lose
   * information Prompt 3's import-resolver and a later phase both need back.
   */
  syntax: "static" | "require" | "dynamic";
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export interface ParsedExport {
  /** For `export * from "./x"` (no local name at all), the adapter's contract is to
   * set this to the empty string rather than widen the field to optional — `name` stays
   * required, matching the given contract verbatim; {@link reExportFrom} is what a
   * consumer actually branches on to detect this shape. `export * as ns from "./x"`
   * sets `name` to `ns` and this field both. */
  name: string;
  isDefault: boolean;
  line: number;
  /** `export * from "./x"` has no local name — carries the re-export source instead. */
  reExportFrom?: string;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export interface ParsedCall {
  /** The callee name. For `obj.foo()` this is `foo`, matching `queries.ts`'s
   * `call.name` capture for both the bare-identifier and member-expression patterns. */
  name: string;
  /**
   * For `obj.foo()` this is `obj` (or the full receiver text for a chained
   * `obj.nested.foo()` — `queries.ts` captures the receiver's whole subtree text, not
   * just an identifier). Absent for a bare `foo()` call.
   *
   * Deliberate addition beyond `plan.md` §10.3's sketch, which types `calls` as a bare
   * `string[]` with no receiver. `plan.md` §11.4 rule 5's method-call heuristic requires
   * knowing whether the receiver's class is imported/instantiated in the calling file —
   * a check that is unrecoverable once the call has been flattened to just its name.
   * `ParsedCall` being an object, not a string, is what keeps that heuristic
   * implementable at the resolver stage rather than needing to be decided here.
   */
  receiver?: string;
  line: number;
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  isExported: boolean;
  isDefault: boolean;
  /** The symbol's declaration text, truncated to a single line/signature by the
   * adapter — not the full body. Stored verbatim on `CodeSymbol.signature`. */
  signature: string;
  /** The nearest preceding block/line comment, if any — stored verbatim on
   * `CodeSymbol.docComment`. */
  docComment?: string;
  /** The enclosing class/interface's *name*, for a method — not an id, since symbol ids
   * do not exist until persistence (Prompt 4's pass-1 upsert). The graph-builder resolves
   * this name to a `CodeSymbol.parentSymbolId` after both symbols have real ids
   * (phase-04 prompt-1 §2.6). */
  parentSymbol?: string;
  /** Cyclomatic complexity — computed by Prompt 2's adapter from the parsed body, not
   * this module. Present on the type now so the adapter has somewhere to put it. */
  complexity: number;
  calls: ParsedCall[];
  /** Class heritage — `class Foo extends Bar` → `["Bar"]`. At most one entry in
   * practice (a class has one superclass), but typed as an array to mirror
   * `implements` and to tolerate `queries.ts`'s `heritage.extends` capture matching
   * more than once without the adapter needing a separate scalar-vs-array shape. */
  extends?: string[];
  /** Interface heritage — `interface Foo extends Bar, Baz` → `["Bar", "Baz"]`, or class
   * heritage — `class Foo implements Bar, Baz` → `["Bar", "Baz"]`. */
  implements?: string[];
}

// ---------------------------------------------------------------------------
// The whole file
// ---------------------------------------------------------------------------

export interface ParsedFile {
  filePath: string;
  language: ParserLanguage;
  imports: ParsedImport[];
  exports: ParsedExport[];
  symbols: ParsedSymbol[];
  /** Count of tree-sitter `ERROR` nodes (`parser-pool.ts`'s `getParseErrorInfo`) — the
   * raw count Prompt 2's adapter applied its tolerance threshold against, kept on the
   * result for observability (§20: parse-failure counts logged per batch) even when the
   * file was still accepted as `parseState="OK"`. */
  parseErrors: number;
  /** In practice only `"OK"` or `"FAILED"` — `@repo/shared`'s third `ParseState` value,
   * `"NOT_PARSED"`, describes a file that was never eligible for parsing at all (wrong
   * language, skipped, binary), and such a file never reaches the adapter that produces
   * a `ParsedFile` in the first place. Typed as the full `ParseState` rather than a
   * narrowed `Extract<...>` so it stays a single source of truth with the `@repo/shared`
   * union — the adapter is what enforces the narrower practical range, not this type. */
  parseState: ParseState;
}
