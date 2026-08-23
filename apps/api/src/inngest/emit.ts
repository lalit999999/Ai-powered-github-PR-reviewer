import { PROJECT_DELETED, type ProjectDeletedData } from "@repo/shared";
import { createLogger } from "../lib/logger.js";
import { inngest } from "./client.js";

const logger = createLogger("inngest.emit");

/**
 * Producer side of the `project/deleted` contract (phase-01 §8). The name and payload
 * shape come from `@repo/shared`, so this and `apps/worker`'s trigger definition are
 * the same declaration seen from both ends.
 *
 * **Emission is best-effort and never fails the request.** Reasoning, recorded rather
 * than assumed: the soft-delete row update is the source of truth and has already
 * committed by the time this runs; the event exists purely to let *future* phases
 * cancel background work, and there is no consumer at all today (§8). Turning a
 * successful, already-committed delete into a 5xx because a fire-and-forget
 * notification with zero subscribers could not be delivered would be strictly worse
 * for the caller. The failure is logged at `error` so it is visible rather than
 * silent.
 *
 * Phase 03, when `cancelOn` handlers make delivery actually matter, should revisit
 * this — most likely with a transactional outbox rather than by making the HTTP
 * response depend on Inngest's availability. Flagged here so that decision is a
 * deliberate one.
 */
export async function emitProjectDeleted(data: ProjectDeletedData): Promise<void> {
  try {
    await inngest.send({ name: PROJECT_DELETED, data });
  } catch (err) {
    logger.error("failed to emit project/deleted", {
      event: PROJECT_DELETED,
      projectId: data.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
