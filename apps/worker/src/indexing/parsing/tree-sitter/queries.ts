/**
 * Tree-sitter query source for imports, exports, symbols, class/interface heritage, call
 * sites, and (TSX only) JSX element names — the raw material Prompt 2's adapter
 * (`adapters/typescript.adapter.ts`, not part of this prompt) normalizes into a
 * {@link ../parsed-file.types.js!ParsedFile}. This module only produces query *source
 * text* and runs none of it — no `Query` object is constructed here, no tree is walked.
 *
 * ## Why these are TypeScript string constants, not `.scm` files on disk
 *
 * `apps/worker/tsconfig.json` builds with `outDir: "dist"` / `include: ["src/**\/*.ts"]`
 * — `tsc` compiles `.ts` files only and copies nothing else into `dist/`. Real `.scm`
 * files under `src/` would parse and test fine locally (via `tsx`/vitest, which read
 * `src/` directly) but would silently vanish from the compiled output
 * `Dockerfile.worker` actually ships, crashing the worker on its first parse with no
 * signal until a container is actually booted. Inlining sidesteps the problem
 * entirely — no Dockerfile change, no build-script copy step, no dev/prod asset-path
 * divergence to keep in sync. The cost is losing `.scm` syntax highlighting in an
 * editor; every pattern below was still authored and verified as real query syntax
 * (see the empirical verification note below), just against a string, not a file.
 *
 * ## Composition, not duplication
 *
 * `TSX_QUERY` and `TYPESCRIPT_QUERY` do not restate `JAVASCRIPT_QUERY`'s patterns —
 * they concatenate it with grammar-specific additions. All three grammars accept the
 * same core patterns for imports/exports/functions/classes/methods/calls, because
 * TypeScript and TSX's grammars are strict supersets of the plain JavaScript grammar's
 * shape for these constructs (verified empirically, not assumed — see below). A pattern
 * that needs restating per grammar would be a sign it isn't actually shared; none of the
 * base patterns needed that here. `TYPESCRIPT_QUERY` adds interface/type-alias/enum
 * declarations, class/interface heritage, and type-only imports — none of which the
 * plain JavaScript grammar has a node for at all (confirmed: the plain `"type"` keyword
 * literal used by the type-only-import pattern does not exist in the JavaScript
 * grammar's node vocabulary and fails query *compilation*, not just matching, if placed
 * in the shared base — this is why it lives in `TYPESCRIPT_QUERY` alone). `TSX_QUERY`
 * adds only JSX element-name capture on top of `TYPESCRIPT_QUERY`.
 *
 * ## Empirical verification
 *
 * Every capture group below was verified — via a throwaway probe script, not by
 * inspection — to produce a **non-empty** match set against a representative snippet
 * covering every construct it targets, run through the real grammars
 * (`tree-sitter-typescript@0.23.2`, `tree-sitter-javascript@0.25.0`) via `web-tree-sitter`.
 * An empty match set is the specific failure mode being guarded against: node type names
 * differ between grammar versions, and a pattern that silently matches nothing produces
 * no error, just quietly missing data. `parser-pool.test.ts`'s
 * `queries.test.ts` sibling (see that file) re-runs this same non-empty-match assertion
 * as a permanent regression test, not just a one-time check.
 *
 * ## Prompt 2 additions (sub-task 2.1)
 *
 * Prompt 1 already inlined the bulk of this module (see the two sections above, both
 * dated to that prompt). Prompt 2's own reading of `phase-04-code-parsing-and-knowledge-
 * graph.md` §18 named three separate `.scm` files at a different path
 * (`tree-sitter/queries/{typescript,tsx,javascript}.scm`) as the expected deliverable;
 * per this prompt's own non-negotiable rule 1 ("read prompt 1's actual output before
 * writing anything"), that literal path was **not** recreated — doing so would have
 * duplicated queries this module already owns and re-opened the exact dist/ packaging
 * gap Prompt 1's own header comment above documents choosing inlining specifically to
 * avoid. Instead, this module is extended in place with the handful of constructs
 * Prompt 1's original sweep did not yet cover, verified against the real grammar the same
 * empirical way (a throwaway probe script dumping S-expressions, not guessed from
 * memory — see docs/decisions/phase-04-log.md, Prompt 2 section, for the transcripts):
 *
 * - `symbol.arrow.node`/`.name` extended to also match a `function_expression` value
 *   (`const foo = function () {}`), not just `arrow_function` — phase-04 §14's own
 *   construct table puts both on the same `arrow-function` row.
 * - `symbol.class.node`/`.name` and `symbol.method.node`/`.name` extended to also match
 *   `abstract_class_declaration` / `abstract_method_signature` — a distinct node type
 *   from `class_declaration` / `method_definition` in this grammar, confirmed empirically
 *   (probe: `abstract class Foo { abstract bar(): void; }`).
 * - `import.named.typeOnly.name` (new): the per-specifier `type` marker
 *   (`import { type Foo, Bar } from "./m"`) is a literal anonymous `"type"` token that is
 *   a *child of the individual `import_specifier`*, not a sibling of `import_clause` the
 *   way the whole-statement marker is — confirmed via a full-tree dump including
 *   anonymous nodes (`toString()` alone hides it). TypeScript-only, same reasoning as the
 *   whole-statement marker already documented above.
 * - `export.equals.node`/`.name` (new): `export = Foo;` — TypeScript's CommonJS-interop
 *   export form. Confirmed empirically that this parses as `export_statement` with the
 *   identifier as a *positional* child (no `declaration:`/`value:` field at all, unlike
 *   every other `export_statement` shape this module already handles), which is why it
 *   needs its own pattern rather than composing with `export.default`/`export.node`.
 *   TypeScript-only (the plain JS grammar has no `=` export form).
 */

// ---------------------------------------------------------------------------
// Shared base — valid TypeScript, TSX, and plain JavaScript
// ---------------------------------------------------------------------------

export const JAVASCRIPT_QUERY = `
; ---------------------------------------------------------------------------
; Imports
; ---------------------------------------------------------------------------

(import_statement
  source: (string) @import.source) @import.node

(import_clause (identifier) @import.default)

(namespace_import (identifier) @import.namespace)

(import_specifier
  name: (_) @import.named.name
  alias: (identifier)? @import.named.alias)

; require("...") — the callee is a plain identifier, so an #eq? predicate
; distinguishes it from an arbitrary call; a dynamic import()'s callee is its own
; distinct grammar node type ("import"), so no predicate is needed for that one below.
(call_expression
  function: (identifier) @import.require.fn
  arguments: (arguments (string) @import.require.source)
  (#eq? @import.require.fn "require")) @import.require.node

(call_expression
  function: (import)
  arguments: (arguments (string) @import.dynamic.source)) @import.dynamic.node

; ---------------------------------------------------------------------------
; Exports
; ---------------------------------------------------------------------------

; The literal "default" token disambiguates "export default X" from "export X" /
; "export { X }" — neither of the two shapes below is reachable from the other, since
; export_statement's "declaration" and "value" fields are mutually exclusive depending
; on whether the default export is a declaration (function/class) or a bare expression.
(export_statement
  "default"
  declaration: (_)) @export.default.node

(export_statement
  "default"
  value: (_) @export.default.value) @export.default.node

(export_statement
  declaration: (function_declaration name: (identifier) @export.name)) @export.node

(export_statement
  declaration: (class_declaration name: (_) @export.name)) @export.node

(export_statement
  declaration: (lexical_declaration
    (variable_declarator name: (identifier) @export.name))) @export.node

(export_specifier
  name: (_) @export.named.name
  alias: (_)? @export.named.alias)

; export * from "./re-export" — no local name; the adapter reads @export.star.source
; as the ParsedExport.reExportFrom value.
(export_statement
  "*"
  source: (string) @export.star.source) @export.star.node

; export * as ns from "./ns-export"
(export_statement
  (namespace_export (identifier) @export.namespace.alias)
  source: (string) @export.namespace.source) @export.namespace.node

; ---------------------------------------------------------------------------
; Symbols
; ---------------------------------------------------------------------------

(function_declaration
  name: (identifier) @symbol.function.name) @symbol.function.node

; An arrow function bound to a const/let — "arrow-function-const" in plan.md §10.2's
; vocabulary. Only the binding shape is captured here; whether it is exported is a
; separate @export.node match the adapter correlates by position.
(variable_declarator
  name: (identifier) @symbol.arrow.name
  value: (arrow_function)) @symbol.arrow.node

; A function *expression* bound the same way (const foo = function () {}) — a distinct
; grammar node from arrow_function, but phase-04 §14's construct table puts both on the
; same "arrow-function" row, so the adapter maps both capture pairs to the same
; SymbolKind. Prompt 2 addition (see this module's header).
(variable_declarator
  name: (identifier) @symbol.arrow.name
  value: (function_expression)) @symbol.arrow.node

; name: (_) rather than a grammar-specific node type — TS/TSX name a class with
; type_identifier, plain JS with identifier. One pattern, both shapes.
(class_declaration
  name: (_) @symbol.class.name) @symbol.class.node

(method_definition
  name: (property_identifier) @symbol.method.name) @symbol.method.node

; ---------------------------------------------------------------------------
; Call sites
; ---------------------------------------------------------------------------

(call_expression
  function: (identifier) @call.name) @call.node

; object: (_) rather than object: (identifier) — deliberately accepts a nested
; member_expression object (obj.nested.method()) too, not just a bare identifier.
; plan.md §11.4 rule 5's method-call heuristic only needs the receiver's *text*, which
; the adapter reads from the whole @call.receiver node regardless of its shape; only the
; simple obj.foo() case is expected to resolve confidently downstream.
(call_expression
  function: (member_expression
    object: (_) @call.receiver
    property: (property_identifier) @call.name)) @call.node
`;

// ---------------------------------------------------------------------------
// TypeScript additions — interfaces, type aliases, enums, heritage, type-only imports.
// None of these node types exist in the plain JavaScript grammar.
// ---------------------------------------------------------------------------

export const TYPESCRIPT_QUERY =
  JAVASCRIPT_QUERY +
  `
; import type { ... } — the whole-statement type-only marker. Per-specifier markers
; (import { type Foo } from "...") are a separate, rarer TS syntax not covered here;
; Prompt 2/3 can extend this pattern if precision measurement (phase-04 §14) shows it
; matters.
(import_statement
  "type"
  (import_clause)) @import.typeOnly.node

(export_statement
  declaration: (interface_declaration name: (type_identifier) @export.name)) @export.node

(export_statement
  declaration: (type_alias_declaration name: (type_identifier) @export.name)) @export.node

(export_statement
  declaration: (enum_declaration name: (identifier) @export.name)) @export.node

(interface_declaration
  name: (type_identifier) @symbol.interface.name) @symbol.interface.node

(type_alias_declaration
  name: (type_identifier) @symbol.typeAlias.name) @symbol.typeAlias.node

(enum_declaration
  name: (identifier) @symbol.enum.name) @symbol.enum.node

; class Foo extends Bar implements Baz, Qux
(extends_clause
  value: (_) @heritage.extends)

(implements_clause
  (_) @heritage.implements)

; interface Foo extends Bar, Baz — a distinct grammar node from a class's extends_clause
(extends_type_clause
  type: (_) @heritage.interfaceExtends)

; abstract class Foo { abstract bar(): void; } — abstract_class_declaration and
; abstract_method_signature are distinct node types from class_declaration and
; method_definition in this grammar (confirmed empirically, not assumed — see this
; module's header). An abstract method has no body field at all, only a signature; the
; adapter's signature/body-boundary logic already tolerates a missing body field by
; falling back to the whole node text, so no separate handling is needed there.
; Prompt 2 addition.
(abstract_class_declaration
  name: (type_identifier) @symbol.class.name) @symbol.class.node

(abstract_method_signature
  name: (property_identifier) @symbol.method.name) @symbol.method.node

; import { type Foo, Bar } from "./m" — the per-specifier marker, a literal anonymous
; "type" token that is a *child of the individual import_specifier* (not a sibling of
; import_clause the way the whole-statement marker above is). Confirmed via a full-tree
; dump including anonymous nodes; toString() alone hides it. Prompt 2 addition.
(import_specifier
  "type"
  name: (_) @import.named.typeOnly.name)

; export = Foo; — TypeScript's CommonJS-interop export form. Confirmed empirically that
; this parses as export_statement with the identifier as a *positional* child (no
; declaration:/value: field at all, unlike every other export_statement shape above),
; which is why it needs its own pattern. Prompt 2 addition.
(export_statement
  "="
  (identifier) @export.equals.name) @export.equals.node
`;

// ---------------------------------------------------------------------------
// TSX addition — JSX element names, which Prompt 2 needs to detect React components.
// ---------------------------------------------------------------------------

export const TSX_QUERY =
  TYPESCRIPT_QUERY +
  `
; name: (_) accepts an identifier ("<div>"), a member_expression ("<Foo.Bar>"), or a
; jsx_namespace_name ("<svg:rect>") — the adapter decides which shapes count as a
; React-component reference; this query only captures the name text.
(jsx_opening_element
  name: (_) @jsx.element.name)

(jsx_self_closing_element
  name: (_) @jsx.selfClosing.name)
`;
