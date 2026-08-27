/** Called bare, with no import, from `string-utils.ts`'s `padAndCapitalize`
 * — a clean rule-3 (UNIQUE_REPO_MATCH) positive case: unique within
 * `@fixture/utils`'s own name-index bucket, no import needed. */
export function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}
