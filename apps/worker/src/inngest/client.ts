import { Inngest } from "inngest";
import { env } from "../config/env.js";
import { JobTrackingMiddleware } from "./middleware/job-tracking.js";
import { LoggingMiddleware } from "./middleware/logging.js";

/**
 * Configured from the validated env module, never process.env directly (phase-00
 * §19). Tenancy middleware is deferred until tenancy-scoped functions exist —
 * phase-00 §8 explicitly defers it past this phase.
 *
 * `LoggingMiddleware` before `JobTrackingMiddleware`, deliberately: the former
 * establishes the base `{ traceId }` context each hook runs inside, and the latter
 * merges `repositoryId`/`projectId` onto whatever context already exists rather than
 * replacing it (see job-tracking.ts) — registering them in this order means the common
 * case never needs its own defensive fallback to trigger.
 */
export const inngest = new Inngest({
  id: "gitprreviewer-worker",
  eventKey: env.INNGEST_EVENT_KEY,
  signingKey: env.INNGEST_SIGNING_KEY,
  middleware: [LoggingMiddleware, JobTrackingMiddleware],
});
