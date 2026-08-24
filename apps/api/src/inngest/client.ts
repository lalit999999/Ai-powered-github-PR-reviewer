import { Inngest } from "inngest";
import { env } from "../config/env.js";

/**
 * Send-only Inngest client. `apps/api` emits events; `apps/worker` serves the
 * functions that consume them, and has its own client with its own app id
 * (`gitprreviewer-worker`). Two apps, two ids — this one never registers a function,
 * so it never needs a signing key or an HTTP endpoint.
 *
 * Configured from the validated env module, never `process.env` directly
 * (phase-00 §19). `INNGEST_EVENT_KEY` was already required by apps/api's config
 * schema in Phase 00, anticipating exactly this.
 */
export const inngest = new Inngest({
  id: "gitprreviewer-api",
  eventKey: env.INNGEST_EVENT_KEY,
});
