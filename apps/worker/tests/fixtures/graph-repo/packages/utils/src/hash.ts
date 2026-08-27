/** Called cross-package from `@fixture/core`'s `auth/login.ts`, via a deep
 * workspace-package subpath specifier (`@fixture/utils` declares no
 * `exports` map, so the subpath falls back to a direct relative path from
 * the package root). */
export function hashPassword(password: string): string {
  let hash = 0;
  for (let i = 0; i < password.length; i += 1) {
    hash = (hash * 31 + password.charCodeAt(i)) | 0;
  }
  return hash.toString(16);
}

/** Same-file call (rule 1) to `hashPassword`, plus a built-in call
 * (`.padStart`) with no repo-symbol collision. */
export function hashPasswordPadded(password: string, width: number): string {
  return hashPassword(password).padStart(width, "0");
}
