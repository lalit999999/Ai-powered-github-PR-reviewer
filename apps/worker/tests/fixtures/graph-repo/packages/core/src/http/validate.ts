/** Second of two same-named `validate` exports within `@fixture/core` — see
 * `../auth/validate.ts`. */
export function validate(req: { body?: unknown }): boolean {
  return req.body !== undefined;
}

/** Same-file call (rule 1) to `validate` above. */
export function validateRequests(reqs: readonly { body?: unknown }[]): boolean {
  return reqs.some((req) => validate(req));
}
