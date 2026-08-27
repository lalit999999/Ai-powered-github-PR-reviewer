import { SESSION_TTL_MS } from "../config";

export interface SessionRecord {
  userId: string;
  expiresAt: number;
}

/** Creates a session record expiring SESSION_TTL_MS from now. */
export function createSession(userId: string): SessionRecord {
  return { userId, expiresAt: Date.now() + SESSION_TTL_MS };
}

export function verifySession(record: SessionRecord): boolean {
  return record.expiresAt > Date.now();
}

/** Same-file calls (rule 1) to both of this file's other exports — a clean,
 * unambiguous positive case reached from a third function. */
export function refreshSession(record: SessionRecord): SessionRecord {
  if (!verifySession(record)) {
    return createSession(record.userId);
  }
  return record;
}
