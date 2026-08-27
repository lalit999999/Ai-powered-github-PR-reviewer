/**
 * Bare `validate(payload)` call with no import — two same-named `validate`
 * exports exist within `@fixture/core` (`auth/validate.ts` and
 * `http/validate.ts`), an N=2 ambiguity case parallel to `dispatch.ts`'s
 * `handler()` call, exercised with a different collision name for variety.
 */
export function runJob(payload: string): boolean {
  return validate(payload);
}
