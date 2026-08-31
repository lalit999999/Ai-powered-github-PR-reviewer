import { prisma } from "@repo/db";

/**
 * The worker's own Prisma access to `WebhookEvent` — Rule C forbids importing
 * `apps/api`'s `webhook-event.repository.ts` directly. This is the same situation
 * `apps/worker/src/indexing/persistence/repository.repository.ts` is in relative to
 * `apps/api`'s `repository.repository.ts` (see that file's own header comment), and it
 * is resolved the same way: a separate, narrower module that reads only what the worker
 * needs — finding stuck `PENDING` rows and flipping them terminal, not the full surface
 * `apps/api`'s own file exposes (`insertPending`, `markIgnored`,
 * `listRecentByRepositoryFullName`, ...).
 *
 * Rule B: only `*.repository.ts` files (and `packages/db/**`) may import `@repo/db`'s
 * Prisma singleton.
 */

const PENDING = "PENDING";
const DISPATCHED = "DISPATCHED";
const FAILED = "FAILED";

export interface PendingWebhookEvent {
  id: string;
  deliveryId: string;
  eventType: string;
  action: string | null;
  /** The resolved events `apps/api`'s `savePendingDispatchPayload` wrote pre-send —
   * re-sent verbatim by the sweeper, never re-derived. See `webhook-sweeper.ts`'s own
   * header comment for why. */
  dispatchPayload: unknown;
}

/**
 * Rows stuck `PENDING` for at least `olderThanMs`, oldest first, capped at `limit`.
 *
 * **Bounded, deliberately.** An unbounded sweep after a long Inngest outage could try to
 * re-send thousands of rows in one cron tick and time out mid-sweep, leaving every row
 * past the timeout still `PENDING` — and then repeat the same overlong scan on the very
 * next tick, never making progress. A capped, oldest-first batch makes recovery
 * incremental and self-resuming instead: each tick clears the oldest slice, and a
 * backlog larger than one batch simply drains over several ticks rather than never
 * draining at all. Matches `stale-index-sweeper`'s own precedent of a bounded, repeatable
 * pass over an unbounded one.
 *
 * `@@index([status, createdAt])` (schema.prisma, added in Prompt 1 specifically for this
 * query) is what makes this cheap at audit-ledger scale.
 */
export async function findPendingOlderThan(
  olderThanMs: number,
  limit: number,
): Promise<PendingWebhookEvent[]> {
  return prisma.webhookEvent.findMany({
    where: {
      status: PENDING,
      createdAt: { lt: new Date(Date.now() - olderThanMs) },
    },
    select: {
      id: true,
      deliveryId: true,
      eventType: true,
      action: true,
      dispatchPayload: true,
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/** `PENDING → DISPATCHED`. `dispatchPayload` is left untouched — it was already written
 * by `apps/api` before this row could ever be found by `findPendingOlderThan`, so there
 * is nothing new to persist here beyond the status transition. */
export async function markDispatched(id: string): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id },
    data: { status: DISPATCHED, dispatchedAt: new Date() },
  });
}

/** `PENDING → FAILED`. Reserved for a row whose `dispatchPayload` is null or
 * unparseable — a condition retrying will never fix, matching `apps/api`'s own
 * `markFailed` convention for a malformed-but-authentic delivery. */
export async function markFailed(
  id: string,
  error: { code: string; message: string },
): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id },
    data: { status: FAILED, error },
  });
}
