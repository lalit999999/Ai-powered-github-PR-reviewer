import {
  PROJECT_DELETED,
  REPOSITORY_INDEX_REQUESTED,
  type ProjectDeletedData,
  type RepositoryIndexRequestedData,
} from "@repo/shared";
import { createLogger } from "@repo/observability";
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
 * **It also must not be awaited by the request.** Measured, not assumed: with an
 * invalid `INNGEST_EVENT_KEY`, the SDK's own retry/backoff made a single
 * `DELETE /api/projects/:id` take **5.3 seconds** before returning its 202. Coupling a
 * user-facing mutation's latency to the availability of a notification channel with no
 * subscribers is the wrong trade, and `202 Accepted` already means "accepted, work
 * continues" — so `project.service` calls this without awaiting. The trace context
 * (`traceId`/`userId`/`projectId`) survives into the continuation via
 * AsyncLocalStorage, so a late failure still logs with full context.
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

/**
 * Producer side of the `repository/index.requested` contract (phase-02 §8). Emitted by
 * `POST /api/projects/:id/repositories` after the `Repository` row is committed in
 * `indexStatus: PENDING`.
 *
 * ## Why this stays fire-and-forget *for this phase* — the decision, argued
 *
 * `emitProjectDeleted` above is un-awaited because a measured 5.3-second SDK backoff on
 * an invalid event key was worse than losing a notification nobody consumed. That
 * reasoning does **not** transfer automatically here, and it was re-examined rather
 * than copied, because this event is not a notification: from Phase 03 onward it is the
 * *only* trigger for indexing, and a silently dropped one means a repository sits in
 * `PENDING` forever with no error anywhere.
 *
 * The same pattern is kept anyway, on three grounds:
 *
 * 1. **Nothing consumes it yet** (§8 is explicit that Phase 03 registers the first
 *    function), so today a dropped event costs exactly nothing, while awaiting would
 *    put Inngest's availability in the latency path of a user-facing mutation that
 *    §7 already specifies as `202 Accepted` — "accepted, work continues".
 * 2. **The durable record is the row, not the event.** The `Repository` row is
 *    committed, in `PENDING`, before this is called. That is a state Phase 03 can
 *    reconcile from directly — "find repositories PENDING with no job and enqueue one"
 *    — which is the correct fix for lost-event recovery regardless of what this
 *    function does. Awaiting the send would not make delivery reliable; it would only
 *    make the failure louder in one of the several ways it can happen.
 * 3. **Awaiting would be a false guarantee.** A successful `send()` means Inngest
 *    accepted the event, not that a function ran. The only thing that actually makes
 *    delivery reliable is a transactional outbox — which `emitProjectDeleted`'s own
 *    comment already flags — and half-measures that look like guarantees are worse than
 *    an honest absence of one.
 *
 * The failure is logged at **`error`** with `repositoryId` and `projectId`, so a
 * dropped trigger is visible rather than silent (§20 requires both ids on this path).
 *
 * TODO(phase-03): revisit when `repository-index` exists and delivery actually matters.
 * The fix is a transactional outbox plus a reconcile sweep over `PENDING` rows — not
 * awaiting this call and not making the HTTP response depend on Inngest being up.
 */
export async function emitRepositoryIndexRequested(data: RepositoryIndexRequestedData): Promise<void> {
  try {
    await inngest.send({ name: REPOSITORY_INDEX_REQUESTED, data });
  } catch (err) {
    logger.error("failed to emit repository/index.requested", {
      event: REPOSITORY_INDEX_REQUESTED,
      projectId: data.projectId,
      repositoryId: data.repositoryId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
