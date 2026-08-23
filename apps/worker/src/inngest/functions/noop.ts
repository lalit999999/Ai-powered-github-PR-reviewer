import { createLogger } from "../../lib/logger.js";
import { inngest } from "../client.js";

/**
 * Phase-00 §8: proves the Inngest client is configured with the right
 * signing/event keys, /api/inngest correctly serves the handler, and the Dev Server
 * can discover and invoke functions from this codebase. Diagnostic only — delete (or
 * leave as a harmless dev-only tool) once Phase 02 introduces the first real event
 * (`repository/index.requested`).
 */
export const noopHandler = inngest.createFunction(
  {
    id: "noop-handler",
    retries: 0,
    triggers: { event: "internal/noop.ping" },
  },
  async ({ runId, step }) => {
    await step.run("log-receipt", async () => {
      // traceId comes from LoggingMiddleware's AsyncLocalStorage context — never
      // threaded manually, matching the phase-00 §20 envelope.
      createLogger("inngest.noop").info("received internal/noop.ping", { runId });
    });
  },
);
