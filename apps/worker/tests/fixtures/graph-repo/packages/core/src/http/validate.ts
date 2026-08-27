/** Second of two same-named `validate` exports within `@fixture/core` — see
 * `../auth/validate.ts`. */
export function validate(req: { body?: unknown }): boolean {
  return req.body !== undefined;
}
