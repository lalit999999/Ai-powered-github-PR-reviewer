import { createLogger } from "../../lib/logger.js";
import { inngest } from "../client.js";

/**
 * Phase-00 §8: proves the Inngest client is configured with the right
 * signing/event keys, /api/inngest correctly serves the handler, and the Dev Server
 * can discover and invoke functions from this codebase. Diagnostic only.
 *
 * **Kept in Phase 02; the deletion moves to Phase 03.** Phase 00 said to delete this
 * "once Phase 02 introduces the first real event (`repository/index.requested`)".
 * Phase 02 introduces that *event* — but §8 is explicit that no function consumes it
 * until Phase 03. Deleting this now would leave the worker with **zero** registered
 * functions, which changes what the Inngest Dev Server displays and removes the only
 * end-to-end proof that the worker is discoverable and wired up at all — at exactly the
 * moment this phase's acceptance signal (§8) is "look at the Dev Server UI".
 *
 * Delete it in Phase 03, when `repository-index` is a real function that proves the
 * same things better. See docs/decisions/phase-02-log.md.
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
