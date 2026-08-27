import { hashPassword } from "@fixture/utils/src/hash";
import { createSession, verifySession } from "./session";

/**
 * `login` calls two functions:
 *  - `hashPassword`, a cross-package named import resolved via a deep
 *    workspace-package subpath (rule 2, NAMED_IMPORT).
 *  - `verifySession`, a same-package named import from a sibling file
 *    (rule 2, NAMED_IMPORT).
 * Both are unambiguous, clean positive cases for the precision label set.
 */
export function login(username: string, password: string): boolean {
  const hashed = hashPassword(password);
  const session = createSession(username);
  return hashed.length > 0 && verifySession(session);
}
