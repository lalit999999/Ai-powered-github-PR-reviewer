import { login } from "@fixture/core";
import { appName } from "@app/shared/constants";

/**
 * `login` is imported from the bare `@fixture/core` package specifier, which
 * resolves to `packages/core/src/index.ts` (the barrel) via
 * `package.json#main` — not directly to `auth/login.ts`. The barrel only
 * re-exports `login` (`export * from "./auth/login"`), so it declares no
 * `login` symbol of its own: rule 2 (NAMED_IMPORT)'s
 * `targetFile.symbols.find(...)` finds nothing at that one hop, and
 * re-exports are not chased further. This is the fixture's deliberate
 * single-hop re-export limitation case (see `packages/core/src/index.ts` and
 * docs/parsing.md) — expected to produce **no** CALLS edge here, even though
 * a human reading the source can see exactly which function this calls.
 */
export function bootstrap(username: string, password: string): string {
  const ok = login(username, password);
  return `${appName()}: ${ok ? "ok" : "failed"}`;
}
