import { getSession } from "@auth/express";
import type { Session } from "@auth/express";
import type { Request } from "express";
import { UnauthenticatedError } from "../errors.js";
import { setTraceUserId } from "../tracing.js";
import { authConfig } from "./config.js";

export type AuthenticatedSession = Session & { user: NonNullable<Session["user"]> & { id: string } };

/**
 * Thin wrapper over @auth/express's own getSession (phase-01 §17 step 4) — reuses the
 * exact cookie-read + database-session-lookup logic Auth.js uses for issuance, rather
 * than re-implementing any part of it here.
 */
export async function getCurrentSession(req: Request): Promise<Session | null> {
  return getSession(req, authConfig);
}

/**
 * The single path every authenticated route uses to resolve the caller. An
 * invalid, expired, or missing session always throws UnauthenticatedError (401) —
 * it never falls open to a default user (phase-01 §4 Reliability, §22).
 *
 * Also extends the trace context with `userId` (phase-01 §20) so every log line for
 * the rest of this request carries it, using the Phase 00 envelope as-is.
 */
export async function requireSession(req: Request): Promise<AuthenticatedSession> {
  const session = await getCurrentSession(req);
  if (!session?.user?.id) {
    throw new UnauthenticatedError("Authentication required");
  }

  setTraceUserId(session.user.id);

  return session as AuthenticatedSession;
}
