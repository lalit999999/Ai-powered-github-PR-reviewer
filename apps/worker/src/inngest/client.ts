import { Inngest } from "inngest";
import { env } from "../config/env.js";
import { LoggingMiddleware } from "./middleware/logging.js";

/**
 * Configured from the validated env module, never process.env directly (phase-00
 * §19). Tenancy middleware is deferred until tenancy-scoped functions exist —
 * phase-00 §8 explicitly defers it past this phase.
 */
export const inngest = new Inngest({
  id: "gitprreviewer-worker",
  eventKey: env.INNGEST_EVENT_KEY,
  signingKey: env.INNGEST_SIGNING_KEY,
  middleware: [LoggingMiddleware],
});
