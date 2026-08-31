import {
  PROJECT_DELETED,
  PULL_REQUEST_CLOSED,
  PULL_REQUEST_REVIEW_REQUESTED,
  REPOSITORY_INDEX_REQUESTED,
  type ProjectDeletedData,
  type PullRequestClosedData,
  type PullRequestReviewRequestedData,
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
export async function emitProjectDeleted(
  data: ProjectDeletedData,
): Promise<void> {
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
 * **Resolved in Phase 03**, per point 2 above: `apps/worker`'s `stale-index-sweeper`
 * (`plan.md` §27.2's own named cron function) is the reconcile sweep — it finds
 * repositories stuck `PENDING` for at least 15 minutes and re-emits this exact event
 * for each (`reason: "sweep"`). This function itself is unchanged: still fire-and-forget,
 * still logging its own failures at `error`, for exactly the three reasons argued
 * above — the sweeper is what makes a dropped event self-healing within its 6-hour
 * cadence, not a reason to change how this call behaves. A transactional outbox (a
 * tighter bound than "up to 6 hours") remains unbuilt, deliberately — see
 * `stale-index-sweeper.ts`'s own header comment for why the sweep alone is this phase's
 * scope and the outbox is not, and docs/decisions/phase-03-log.md for the fuller record.
 */
export async function emitRepositoryIndexRequested(
  data: RepositoryIndexRequestedData,
): Promise<void> {
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

export type EmitResult = { ok: true } | { ok: false; error: string };

/** Bounds `emitPullRequestReviewRequested`'s own `Promise.race` (see that function's
 * doc comment for the full budget argument this number comes from). Not exported —
 * internal to this one emitter's timeout, not a general-purpose constant. */
const EMIT_TIMEOUT_MS = 300;

/**
 * Producer side of `pull-request/review.requested` (phase-06 §8) — and the first
 * emitter in this file that is **awaited** and **returns a result** instead of
 * swallowing its own failure and running fire-and-forget. `emitProjectDeleted` and
 * `emitRepositoryIndexRequested` above both do the opposite; their doc comments argue
 * three grounds for it. Read those first — this comment only makes sense as a departure
 * from them.
 *
 * ## Why none of the three grounds transfer here
 *
 * 1. **"Nothing consumes it yet."** False for this event, uniquely among the three:
 *    `@repo/shared`'s own doc comment on `PULL_REQUEST_REVIEW_REQUESTED` records that
 *    Phase 07 registers the consumer at the moment this event is *defined* — this is
 *    the first event in the system with a real reader at definition time, not a
 *    forward declaration nobody reads yet.
 * 2. **"The durable record is the row, not the event."** The `WebhookEvent` row is
 *    still the durable record, committed before this call — but unlike the other two
 *    emitters, the *caller*'s next action depends on knowing whether the send actually
 *    worked. `webhook.service.ingestDelivery` marks that row `DISPATCHED` on success and
 *    leaves it `PENDING` for the sweeper on failure (phase-06 §11's state table).
 *    Swallowing the error here would erase that distinction: every failed dispatch
 *    would read as `DISPATCHED`, and the sweeper — which only scans `PENDING` rows —
 *    would never see it, silently losing every review requested during an Inngest
 *    outage. A result the caller can branch on is the entire retry mechanism, not an
 *    optional refinement.
 * 3. **"Awaiting would be a false guarantee."** Still true in the narrow sense — a
 *    successful `send()` means Inngest accepted the event, not that a function ran —
 *    but that is exactly the guarantee `WebhookEvent.status` is defined to carry:
 *    "accepted for dispatch," not "reviewed." Anything past acceptance is Phase 07's
 *    concern, tracked on its own rows.
 *
 * ## Awaited, but bounded
 *
 * `emitRepositoryIndexRequested`'s own comment records a **measured** 5.3-second SDK
 * backoff against an invalid event key. Awaiting that unconditionally would blow this
 * endpoint's 500 ms p99 budget (phase-06 §12/§14.1) on the very failure mode this
 * function exists to detect. So the send is wrapped in `withTimeout`, a `Promise.race`
 * against `EMIT_TIMEOUT_MS`. The installed `inngest@4.18.1`'s `send()`
 * (`node_modules/inngest/components/Inngest.d.ts`) takes `(payload, options?: { env?:
 * string })` — no per-call timeout option — so there is nothing to configure through the
 * SDK; this is hand-rolled instead. A timeout is treated identically to a rejected
 * send: `{ ok: false }`, which leaves the row `PENDING`. A slow-but-would-have-succeeded
 * send is not distinguishable from a genuinely failed one from here, and does not need
 * to be — the sweeper retries either way, and a resulting duplicate is caught by both
 * the event `id` below and `WebhookEvent.deliveryId`'s own unique constraint.
 *
 * `EMIT_TIMEOUT_MS = 300`: the total budget is 500 ms (phase-06 §12/§14.1).
 * `webhook.service.ts`'s own comment counts six DB statements on the happy path plus one
 * Redis rate-limit check; budgeted generously at ~25 ms each for a database and cache in
 * the same region as this service, that is ~175 ms, leaving headroom for JSON parsing,
 * HMAC verification, and response serialization before this call even starts. 300 ms is
 * what remains of the budget — comfortably more than a healthy connection to Inngest's
 * ingest endpoint needs, while still cutting a hung one off well before GitHub's own
 * ~10 s webhook delivery timeout would fire a retry anyway.
 *
 * ## Idempotency: the event's own `id`, a second dedup layer beneath `deliveryId`
 *
 * Each event's Inngest-level `id` is set to the router's `prKey`
 * (`${repositoryId}:${prNumber}:${headSha}`) — verified against the installed
 * `inngest@4.18.1`'s own type, `MinimalEventPayload.id?: string`
 * (`node_modules/inngest/types.d.ts`): *"A unique id used to idempotently process a
 * given event payload. Set this when sending events to ensure that the event is only
 * processed once; if an event with the same ID is sent again, it will not invoke
 * functions."* That is what the installed package's shipped types state; they do not
 * quantify a dedup-window duration anywhere in this package's `.d.ts`/`.md` files, so
 * none is asserted here — what is verified is the field's existence, its type, and its
 * documented purpose, not a specific retention window.
 *
 * `prKey` is **per tenant** (`event-router.ts`'s own doc comment: two fan-out entries
 * for the same GitHub pull request get two different `repositoryId`s, hence two
 * different `prKey`s). That is what lets `id`-based dedup and the fan-out coexist:
 * an `id` derived from something PR-global instead (say, `${prNumber}:${headSha}` alone)
 * would make Inngest silently drop the *second* tenant's event as a duplicate of the
 * first — breaking fan-out in a way no single-tenant unit test would ever catch.
 */
export async function emitPullRequestReviewRequested(
  events: readonly PullRequestReviewRequestedData[],
): Promise<EmitResult> {
  const payloads = events.map((data) => ({
    name: PULL_REQUEST_REVIEW_REQUESTED,
    data,
    id: data.prKey,
  }));

  try {
    await withTimeout(inngest.send(payloads), EMIT_TIMEOUT_MS);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("failed to emit pull-request/review.requested", {
      event: PULL_REQUEST_REVIEW_REQUESTED,
      eventCount: events.length,
      prKeys: events.map((event) => event.prKey),
      error: message,
    });
    return { ok: false, error: message };
  }
}

/**
 * Producer side of `pull-request/closed` (phase-07 sub-task 1.3) — modeled directly on
 * `emitPullRequestReviewRequested` immediately above, **not** on the fire-and-forget
 * `emitProjectDeleted`/`emitRepositoryIndexRequested` emitters at the top of this file.
 * Same three grounds, restated for this event specifically:
 *
 * 1. This event has a real consumer from the moment it is defined — a later prompt's
 *    `cancelOn` predicate (see `@repo/shared`'s own doc comment on `PULL_REQUEST_CLOSED`).
 * 2. A dropped close event is not cosmetic: it leaves an in-flight review running
 *    against a PR nobody can act on any more, burning real LLM budget for no reader.
 * 3. Awaiting still only proves Inngest *accepted* the event, not that a function ran —
 *    the same honest limit `emitPullRequestReviewRequested`'s own comment names.
 *
 * Bounded by the same `EMIT_TIMEOUT_MS` budget and the same `withTimeout` wrapper, for
 * the same reason: an unbounded await here would put Inngest's availability back in the
 * latency path of the webhook endpoint's 500 ms p99 budget.
 *
 * **No `id` is set on the send.** `emitPullRequestReviewRequested` sets `id: data.prKey`
 * specifically because a `synchronize` webhook can legitimately redeliver the same
 * commit; a `pull_request.closed` delivery has no equivalent "same close, redelivered
 * with identical meaning" case Inngest itself needs to dedup — `WebhookEvent.deliveryId`'s
 * own unique constraint already stops a redelivered `closed` webhook from reaching this
 * function twice.
 */
export async function emitPullRequestClosed(
  events: readonly PullRequestClosedData[],
): Promise<EmitResult> {
  const payloads = events.map((data) => ({ name: PULL_REQUEST_CLOSED, data }));

  try {
    await withTimeout(inngest.send(payloads), EMIT_TIMEOUT_MS);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("failed to emit pull-request/closed", {
      event: PULL_REQUEST_CLOSED,
      eventCount: events.length,
      prRefs: events.map((event) => event.prRef),
      error: message,
    });
    return { ok: false, error: message };
  }
}

/** `Promise.race` against a timer — see `emitPullRequestReviewRequested`'s own comment
 * for why: the installed `inngest@4.18.1` client exposes no per-call send timeout. The
 * timer is cleared on whichever path wins, so a fast, successful send never leaves a
 * dangling timer behind. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`emit timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}
