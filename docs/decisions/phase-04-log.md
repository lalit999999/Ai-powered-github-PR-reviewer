# Phase 04 — Prompt 1 Decision Log

Records the judgment calls made implementing **Prompt 1** of Phase 04 (parser runtime,
shared vocabulary, knowledge-graph schema). Same convention as
`phase-00-log.md`/…/`phase-03-log.md`: records what was decided and what could not be
verified from this environment.

## 1. Sub-task 1.1 — tree-sitter binding

**Chosen: `web-tree-sitter` (WASM), not the native `tree-sitter` binding.** One binding in
dev, CI, and the `node:22-slim` Docker runtime; no `node-gyp`, no compiler toolchain in
`Dockerfile.worker`; `.wasm` files ride along with the existing `pnpm install --prod`
Docker layer with no Dockerfile change (§2.1 non-negotiable rule 1: no repository code is
ever executed — tree-sitter only ever parses text).

**Versions pinned** (`apps/worker/package.json`, exact, no `^`/`~`):

| Package | Version |
|---|---|
| `web-tree-sitter` | `0.26.13` |
| `tree-sitter-typescript` | `0.23.2` |
| `tree-sitter-javascript` | `0.25.0` |

**Ladder rung landed on: 1 (no fallback needed).** The genuine unknown named by the
prompt — whether `tree-sitter-typescript@0.23.2`'s `.wasm` (built by an older tree-sitter
CLI) loads under `web-tree-sitter@0.26.13`'s expected ABI — was resolved empirically: it
loads and parses without error. No pin-down, no swap to `tree-sitter-wasms`, no fallback
to the native binding was needed. `Language.abiVersion` reports `14` for both
`typescript`/`tsx` grammars and `15` for `javascript` — different ABI versions from each
other, both accepted by the same `web-tree-sitter@0.26.13` runtime without complaint,
confirming `web-tree-sitter` supports a range of grammar ABI versions rather than a single
exact one.

**Probe script** (throwaway, run from `apps/worker/` so `node_modules` resolution matches
where the real code lives; never committed — copy retained at
`/tmp/claude-*/scratchpad/probe-tree-sitter.mjs` for this session only):

```
Resolved wasm paths: {
  typescript: '.../tree-sitter-typescript@0.23.2/node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: '.../tree-sitter-typescript@0.23.2/node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm',
  javascript: '.../tree-sitter-javascript@0.25.0/node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm'
}
Parser.init() succeeded

=== typescript ===
abiVersion: 14
hasError: false
S-expression: (program (interface_declaration ...) (export_statement declaration: (class_declaration ... (class_heritage (i...

=== tsx ===
abiVersion: 14
hasError: false
S-expression: (program (interface_declaration ...) (export_statement declaration: (class_declaration ... (class_heritage (i...

=== javascript ===
abiVersion: 15
hasError: false
S-expression: (program (function_declaration ...) (export_statement value: (identifier)))

All three grammars loaded and parsed successfully.
```

Run under Node 22.23.1 — the same major the worker deployable (`node:22-slim`) uses.

**pnpm build-script policy.** `tree-sitter-typescript`/`tree-sitter-javascript` both ship
`"install": "node-gyp-build"` (their native-binding build step). pnpm 11 blocked these by
default (`[ERR_PNPM_IGNORED_BUILDS]`) and auto-appended placeholder entries to
`pnpm-workspace.yaml`'s `allowBuilds` map. Since the WASM binding never touches the native
`.node` output, both are set `false` explicitly (not left unset) — `pnpm install` then
completes with no ignored-build-script warning, and no compiler toolchain is ever invoked
for these two packages, consistent with the whole reason WASM was chosen.

## Outstanding — carried into later sub-tasks of this prompt

- [ ] Sub-tasks 1.2–1.6 (shared vocabulary, Prisma schema, parser pool, queries,
      `ParsedFile` contract) not yet started as of this log entry — appended to below as
      completed.
