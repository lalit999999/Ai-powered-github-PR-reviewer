import { capitalize } from "@utils/string-utils";

/** First of two same-named `handler` exports within `@fixture/core` (see also
 * `../webhooks/handler.ts`) — the N=2 ambiguity case `jobs/dispatch.ts`'s
 * bare `handler()` call exercises.
 *
 * Calls `capitalize`, imported via the `@utils/*` tsconfig path alias
 * (inherited from the repo-root tsconfig — this package's own tsconfig
 * declares no `paths` of its own) rather than the `@fixture/utils` workspace
 * package name, deliberately exercising the alias resolution step instead of
 * step 3 of the ladder for this one call site.
 */
export function handler(body: string): string {
  return capitalize(body);
}
