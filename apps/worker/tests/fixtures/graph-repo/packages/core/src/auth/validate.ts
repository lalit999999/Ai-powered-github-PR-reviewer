/** First of two same-named `validate` exports within `@fixture/core`
 * (see also `../http/validate.ts`) — an intentional N=2 ambiguity case for
 * `jobs/run-job.ts`'s bare `validate()` call. */
export function validate(input: unknown): boolean {
  return typeof input === "string" && input.length > 0;
}
