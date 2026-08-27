import { Serializable } from "@fixture/core/src/models/serializable";

/**
 * Cross-package `implements`, via a **non**-type-only named import of
 * `Serializable` — a deep workspace-package subpath, deliberately bypassing
 * `@fixture/core`'s barrel (which only re-exports it, and re-exports are not
 * chased — see `packages/core/src/index.ts`). Since the import is not
 * `import type`, heritage rule 2 (NAMED_IMPORT) is expected to resolve this
 * cleanly, unlike `http/middleware.ts`'s deliberate `import type`
 * counter-example.
 */
export class DateFormatter implements Serializable {
  constructor(private readonly epochMs: number) {}

  serialize(): string {
    return new Date(this.epochMs).toISOString();
  }
}

export function formatDate(epochMs: number): string {
  return new DateFormatter(epochMs).serialize();
}

/** Same-file call (rule 1) to `formatDate` above, plus a built-in call
 * (`Array.prototype.map`) that must not resolve to any repo symbol. */
export function formatDates(epochMsList: readonly number[]): string[] {
  return epochMsList.map((epochMs) => formatDate(epochMs));
}
