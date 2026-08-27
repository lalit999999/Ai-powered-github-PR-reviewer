import { SESSION_TTL_MS } from "../config";

export interface SessionRecord {
  userId: string;
  expiresAt: number;
}

/** Creates a session record expiring SESSION_TTL_MS from now. */
export function createSession(userId: string): SessionRecord {
  return { userId, expiresAt: Date.now() + SESSION_TTL_MS };
}

/** Same-file call to createSession — rule 1 (SAME_FILE) is only reachable
 * from another symbol in this file; verifySession itself does not call it,
 * kept here only as the session record's producer for login.ts to import. */
export function verifySession(record: SessionRecord): boolean {
  return record.expiresAt > Date.now();
}
