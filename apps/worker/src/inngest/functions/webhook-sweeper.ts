import { createLogger } from "@repo/observability";
import {
  PULL_REQUEST_REVIEW_REQUESTED,
  type PullRequestReviewRequestedData,
} from "@repo/shared";
import * as webhookEventRepository from "../../webhooks/webhook-event.repository.js";
import type { PendingWebhookEvent } from "../../webhooks/webhook-event.repository.js";
import { inngest } from "../client.js";

/**
 * `phase-06-webhook-ingestion.md` Prompt 4 sub-task 4.1's `webhook-sweeper` cron — the
 * `WebhookEvent` counterpart to `stale-index-sweeper.ts` (read that file first; this one
 * is deliberately built as its sibling, same cron shape, same pure-builder seam, same
 * argued-not-asserted header). It re-drives any `WebhookEvent` row that `apps/api`'s
 * `webhook.service.ts` left `PENDING` because the Inngest send inside
 * `emitPullRequestReviewRequested` failed or hung — that file's own comment names the
 * sweeper as the retry mechanism for exactly this case.
 *
 * ## Why a cron sweep, not something stronger
 *
 * Same answer `stale-index-sweeper.ts` gives for `Repository`/`IndexJob`, not re-derived
 * here: a transactional outbox would catch a dropped send within seconds instead of up to
 * a sweep interval, but it is a standalone piece of infrastructure this phase's scope
 * does not ask for. The sweep is the smaller, named, load-bearing piece.
 *
 * ## The "older than N ms" threshold is load-bearing, not decoration
 *
 * A row is `PENDING` for the few hundred milliseconds between
 * `savePendingDispatchPayload` and `markDispatched` on the *happy* path too. Sweeping
 * with too small a threshold would race a request that is still mid-flight and
 * double-send. `emit.ts`'s own `EMIT_TIMEOUT_MS = 300` bounds the Inngest send itself,
 * and `webhook.service.ts`'s own comment budgets the *whole* request — six DB
 * statements, one Redis check, JSON parsing, HMAC verification — at ~500 ms p99
 * (phase-06 §12/§14.1). `PENDING_THRESHOLD_MS` below is set to 60,000 ms — two orders of
 * magnitude past that 500 ms budget — so nothing still inside its own request lifecycle
 * is ever mistaken for stuck, while a genuine failure is still caught within one or two
 * sweep ticks (the cron itself runs every minute).
 *
 * ## Re-sending is safe
 *
 * Because of the `prKey` event-id dedup `emit.ts` already sets on every send (`id:
 * data.prKey`) — Inngest drops a duplicate inside its dedup window, so a swept row that
 * actually did dispatch costs nothing. This is the identical "safe to re-run against
 * something not actually stuck" argument `stale-index-sweeper.ts` makes for its own
 * heuristic; not re-derived here, only pointed at.
 *
 * ## `dispatchPayload` is re-sent verbatim, not re-derived
 *
 * Tenant resolution could legitimately produce a *different* fan-out by sweep time (a
 * repository connected or disconnected in the meantime) — the sweeper's job is to
 * complete the dispatch that was decided at delivery time, not to re-decide it.
 * `webhook-event.repository.ts`'s (apps/api) own `savePendingDispatchPayload` doc comment
 * and Prompt 1 §3.3 already made this choice; restated here because it is this file's
 * entire reason for reading `dispatchPayload` instead of re-resolving tenants itself.
 *
 * ## A row with a null or unparseable `dispatchPayload` cannot be swept
 *
 * It is marked `FAILED` with a distinct code instead of being retried forever — an
 * un-sweepable row that stays `PENDING` would pollute every subsequent sweep's result
 * set. The real (if narrow) case this catches: a crash between `insertPending` and
 * `savePendingDispatchPayload` on the API side leaves exactly a null-payload `PENDING`
 * row.
 */

const PENDING_THRESHOLD_MS = 60 * 1000;
const SWEEP_BATCH_LIMIT = 50;

export interface SweepSend {
  rowId: string;
  deliveryId: string;
  events: {
    name: typeof PULL_REQUEST_REVIEW_REQUESTED;
    data: PullRequestReviewRequestedData;
    id: string;
  }[];
}

export interface SweepSkip {
  rowId: string;
  deliveryId: string;
  code: string;
  message: string;
}

export interface SweepPlan {
  sends: SweepSend[];
  skips: SweepSkip[];
}

/**
 * Just enough shape-checking to safely reconstruct an Inngest send from a stored
 * `Json?` column — not a full re-validation of business rules already applied once at
 * ingestion time by `webhook.schema.ts`/`event-router.ts`. `prKey` is checked because it
 * becomes the event's dedup `id`; `repositoryId`/`projectId` because their absence would
 * mean this value was never a real `PullRequestReviewRequestedData[]` to begin with (a
 * hand-edited row, or the null/crash case this function exists to catch).
 */
function isReplayableDispatchPayload(
  value: unknown,
): value is PullRequestReviewRequestedData[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    const row = item as Record<string, unknown>;
    return (
      typeof row.prKey === "string" &&
      typeof row.repositoryId === "string" &&
      typeof row.projectId === "string"
    );
  });
}

/**
 * Pure — no `step`/Inngest dependency — so it is unit-testable directly, matching
 * `stale-index-sweeper.ts`'s own `buildSweepEvents`. Splits the batch into rows safe to
 * re-send (`sends`) and rows whose `dispatchPayload` cannot be trusted (`skips`), per
 * this file's own header comment.
 */
export function buildSweepSends(
  rows: readonly PendingWebhookEvent[],
): SweepPlan {
  const sends: SweepSend[] = [];
  const skips: SweepSkip[] = [];

  for (const row of rows) {
    if (!isReplayableDispatchPayload(row.dispatchPayload)) {
      skips.push({
        rowId: row.id,
        deliveryId: row.deliveryId,
        code: "UNSWEEPABLE_DISPATCH_PAYLOAD",
        message: `WebhookEvent ${row.deliveryId} has a null or malformed dispatchPayload and cannot be swept`,
      });
      continue;
    }

    sends.push({
      rowId: row.id,
      deliveryId: row.deliveryId,
      // `id: data.prKey` mirrors emit.ts's own idempotency key exactly — this is a
      // *replay* of the original dispatch, not a fresh one, so it must dedup against it.
      events: row.dispatchPayload.map((data) => ({
        name: PULL_REQUEST_REVIEW_REQUESTED,
        data,
        id: data.prKey,
      })),
    });
  }

  return { sends, skips };
}

export const webhookSweeper = inngest.createFunction(
  {
    id: "webhook-sweeper",
    retries: 1,
    concurrency: 1,
    timeouts: { finish: "2m" },
    triggers: { cron: "* * * * *" },
  },
  async ({ step }) => {
    const logger = createLogger("webhooks.webhook-sweeper");

    const rows = await step.run("find-pending-older-than-threshold", () =>
      webhookEventRepository.findPendingOlderThan(
        PENDING_THRESHOLD_MS,
        SWEEP_BATCH_LIMIT,
      ),
    );

    if (rows.length === 0) {
      // §16's own "a silent sweeper is indistinguishable from a broken one" — logged at
      // info, once per tick, exactly as stale-index-sweeper.ts does for its own empty
      // case, so "cron is healthy but idle" stays distinguishable from "cron stopped
      // running" in the logs.
      logger.info("webhook-sweeper found nothing to sweep");
      return { found: 0, dispatched: 0, failed: 0 };
    }

    const { sends, skips } = buildSweepSends(rows);

    if (sends.length > 0) {
      await step.sendEvent(
        "re-dispatch-pending-webhook-events",
        sends.flatMap((send) => send.events),
      );
    }

    await step.run("mark-sweep-outcomes", async () => {
      for (const send of sends) {
        await webhookEventRepository.markDispatched(send.rowId);
      }
      for (const skip of skips) {
        await webhookEventRepository.markFailed(skip.rowId, {
          code: skip.code,
          message: skip.message,
        });
      }
    });

    logger.warn("webhook-sweeper re-dispatched pending webhook deliveries", {
      found: rows.length,
      dispatched: sends.length,
      failed: skips.length,
    });

    return {
      found: rows.length,
      dispatched: sends.length,
      failed: skips.length,
    };
  },
);
