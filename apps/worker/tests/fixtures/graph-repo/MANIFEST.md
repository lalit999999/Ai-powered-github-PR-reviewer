# graph-repo — the Phase 04 knowledge-graph fixture

A small, committed-as-source TypeScript monorepo used by two sub-tasks of Phase 04 Prompt
5: the structural graph test (`apps/worker/tests/integration/graph-fixture.test.ts`) and the
call-edge precision measurement (`apps/worker/tests/integration/call-precision.test.ts`,
labels in `graph-repo-labels.json`). It is committed as real source, not a tarball, so both
suites can run the actual parsing/resolution pipeline against it and so the 100 hand-labeled
call edges stay stable and auditable.

**This directory is excluded from `pnpm lint`, `pnpm format:check`, and `pnpm typecheck`.**
It deliberately contains unresolvable imports, an unparseable file, and code shaped to
exercise ambiguity — none of that is a defect in the fixture.

## Shape

```
graph-repo/
  package.json, pnpm-workspace.yaml, tsconfig.json   — repo root; two workspace packages
  packages/core/         "@fixture/core"              — depends on @fixture/utils
  packages/utils/        "@fixture/utils"              — depends on @fixture/core
  apps/web/               "@fixture/web"                — depends on both
  src/                     no *own* package.json — files here resolve to the root
                            manifest's own name ("graph-repo-fixture"), not null;
                            `packageName` is only ever null when no ancestor
                            package.json exists at all, which never happens here
```

`packages/core` and `packages/utils` import each other (`core/auth/login.ts` calls
`utils/hash.ts`'s `hashPassword`; `utils/string-utils.ts` imports `core/config.ts`'s
`LOG_PREFIX`) — a genuine mutual workspace dependency, not a contrived cycle.

## Hard cases, and where each one lives

| Case | Where |
|---|---|
| Same-named exported functions across the repo (`handler`, `index`, `render` — phase-04 §22's own examples) | `handler`: `packages/core/src/http/handler.ts` + `packages/core/src/webhooks/handler.ts` (N=2, same package). `render`: `src/components/{button,modal,page,panel}-render.ts` (N=4, top-level). `index`: `packages/utils/src/registry.ts` + `apps/web/src/pages/list-index.ts` (benign, never called ambiguously). |
| A barrel `index.ts` re-exporting from three-plus modules | `packages/core/src/index.ts` (`export * from` × 4). Re-exports fold into `imports` (a real `IMPORTS` edge from the barrel to each re-exported file), but a caller importing a symbol *through* the barrel only resolves one hop — the barrel's own `symbols` array is empty, so rule 2 (NAMED_IMPORT) cannot chase through it. `apps/web/src/main.ts`'s `login()` call is the deliberate demonstration of this — see its own comment. |
| Two workspace packages importing each other | `packages/core` ↔ `packages/utils`, see above. |
| tsconfig `paths` aliases, including one alias that is a prefix of another | Root `tsconfig.json`: `@core/*`, `@utils/*` (inherited by `packages/*` and top-level `src/*`, which have no `paths` of their own). `apps/web/tsconfig.json`: `@app/*` vs `@app/shared/*` — the latter is a strict prefix-extension of the former; `apps/web/src/main.ts` imports `@app/shared/constants`, which only resolves correctly if the resolver prefers the longer, more specific match. |
| ESM `.js`-specifier imports resolving to `.ts` files | `apps/web/src/legacy/esm-interop.ts` imports `./sibling.js`; only `sibling.ts` exists. |
| Class hierarchies three deep, plus interface implementation | `packages/core/src/models/base-entity.ts` → `entity.ts` → `named-entity.ts` (three `EXTENDS` links), `named-entity.ts` also `implements Serializable`. `packages/core/src/http/middleware.ts` is a second, deliberately-broken `implements` case: the import is `import type`, which heritage rule 2 excludes by design. |
| Test files — some by path pattern, some only by framework import | `apps/web/tests/user-card.test.tsx` (path convention). `src/checks/verify-utils.ts` (no path convention at all — detected only because it imports `vitest`). |
| A file that is genuinely unparseable | `src/broken/unparseable.ts` — an unclosed parameter list near the top of a small file, calibrated (per Prompt 2's own finding) to clear the >10% error-node tolerance ratio. |
| A call site whose correct resolution is genuinely ambiguous, N>3 | `src/api/handler.ts` calls bare `render()`; four same-named candidates exist (`src/components/*-render.ts`), all sharing the caller's own bucket (`packageName: "graph-repo-fixture"`, the root manifest), so rule 4's `N > 3` skip is expected to produce **no** edge. |

## Other things this fixture exercises

- **N=2 ambiguity, resolved (not skipped)**: `packages/core/src/jobs/dispatch.ts` calls bare
  `handler()` (two same-package candidates); `packages/core/src/jobs/run-job.ts` calls bare
  `validate()` (two same-package candidates, a different collision name for variety). Both
  should produce two `AMBIGUOUS_TIEBREAK` edges each, at confidence `0.4/2 = 0.2`.
- **A deep, non-exports-map workspace subpath import**: `packages/core/src/auth/login.ts`
  imports `@fixture/utils/src/hash` directly (no `exports` field on that `package.json`, so
  the subpath falls back to a relative path from the package root).
- **A tsconfig-path-alias cross-package call**: `packages/core/src/http/handler.ts` imports
  `capitalize` via `@utils/string-utils` (the inherited root alias) rather than the
  `@fixture/utils` workspace package name — a different resolution step than the login/hash
  case above, on purpose.
- **React components and hooks**: `apps/web/src/hooks/use-user.ts` (`useUser`, matches the
  hook-name pattern) and `apps/web/src/components/user-card.tsx` (`UserCard`, a PascalCase
  function returning JSX).
- **A non-callable export**: `packages/core/src/config.ts`'s `LOG_PREFIX`/`SESSION_TTL_MS`
  constants produce no `CodeSymbol` at all (`SymbolKind.VARIABLE` is declared but never
  extracted — a known Prompt 2 gap) but are still imported for realism.

## Labeling note

`graph-repo-labels.json`'s 100 entries were written by reading this source directly and
independently judging each call site's correct resolution, then compared against what the
resolver actually produced — not the reverse. See that file's own header and
`call-precision.test.ts` for the full methodology.
