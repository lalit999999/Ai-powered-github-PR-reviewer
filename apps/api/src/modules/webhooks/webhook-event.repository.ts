import { prisma } from "@repo/db";

/**
 * Prisma queries only — no business logic, no logging, no error translation beyond
 * turning Prisma's own constraint-violation shape into a domain-level result (see
 * `insertPending` below). Only files matching `*.repository.ts` (and `packages/db/**`)
 * may import `@repo/db`'s Prisma-backed exports (Rule B, phase-00 §3).
 *
 * Owns every write to `WebhookEvent` from `apps/api`. Nothing in this file is
 * project/tenant scoped — the table itself has no tenant column (see the schema's own
 * header comment on `WebhookEvent`): a delivery is scoped to a GitHub repository, not a
 * project, and the fan-out that turns one delivery into per-project work happens one
 * layer up, in `repository.repository.ts`'s `findConnectedByGithubRepoId`.
 *
 * No unit test for this file specifically — it is thin Prisma access, exercised by
 * Prompt 5's integration suite against a real database. A test that mocked `prisma`
 * here would only prove the mock was configured correctly, not that the query works.
 */

const PENDING = "PENDING";
const DISPATCHED = "DISPATCHED";
const IGNORED = "IGNORED";
const FAILED = "FAILED";

const WEBHOOK_EVENT_SELECT = {
  id: true,
  deliveryId: true,
  eventType: true,
  action: true,
  status: true,
  dispatchedAt: true,
  error: true,
  createdAt: true,
} as const;

export interface WebhookEventRecord {
  id: string;
  deliveryId: string;
  eventType: string;
  action: string | null;
  status: string;
  dispatchedAt: Date | null;
  error: unknown;
  createdAt: Date;
}

export type InsertWebhookEventResult = { ok: true; id: string } | { ok: false; reason: "DUPLICATE_DELIVERY" };

/** Prisma signals a unique-constraint violation with `code: "P2002"`. Duck-typed rather
 * than `instanceof PrismaClientKnownRequestError` so the check works across Prisma's
 * driver-adapter client without importing an error class from the generated client
 * (Rule B keeps that import inside packages/db). This is a **third** copy of a helper
 * `repository.repository.ts` and `project.repository.ts` already each carry — a shared
 * "prisma-errors.ts" would be a fourth file all three import for six lines, which is a
 * worse trade than three identical six-line functions. Consistent, not sloppy. */
function isUniqueConstraintViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "P2002";
}

/**
 * Inserts a `WebhookEvent` row in `status: PENDING`.
 *
 * **The `deliveryId` unique constraint is the *real* dedup mechanism, not a pre-check
 * `SELECT`.** A pre-check races under concurrent redelivery: two simultaneous requests
 * carrying the same `X-GitHub-Delivery` both see "not present" and both would proceed.
 * Only the database's own unique constraint actually holds under that race, so a
 * collision is surfaced here as a **domain outcome**, not an exception — mirroring
 * `repository.repository.create`'s `ALREADY_CONNECTED` handling exactly. Prompt 5's
 * integration suite tests this concurrency directly; a mocked test cannot exercise the
 * race at all, which is the other reason this file carries no unit test of its own.
 */
export async function insertPending(input: {
  deliveryId: string;
  eventType: string;
  action: string | null;
  installationId: bigint | null;
  repositoryFullName: string | null;
}): Promise<InsertWebhookEventResult> {
  try {
    const row = await prisma.webhookEvent.create({
      data: {
        deliveryId: input.deliveryId,
        eventType: input.eventType,
        action: input.action,
        installationId: input.installationId,
        repositoryFullName: input.repositoryFullName,
      },
      select: { id: true },
    });
    return { ok: true, id: row.id };
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      return { ok: false, reason: "DUPLICATE_DELIVERY" };
    }
    throw err;
  }
}

/**
 * `PENDING → DISPATCHED`, once the Inngest send has actually succeeded. Writes
 * `dispatchPayload` again (not just `dispatchedAt`/`status`) so this function is
 * self-sufficient: it does not depend on `savePendingDispatchPayload` having run first
 * to leave the row in a fully consistent state, even though the service always calls
 * both in sequence today.
 */
export async function markDispatched(id: string, dispatchPayload: unknown): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id },
    data: { status: DISPATCHED, dispatchedAt: new Date(), dispatchPayload: dispatchPayload as object },
  });
}

/**
 * `PENDING → IGNORED`. `reason` is written into the `error` Json column even though
 * nothing failed — a deliberate overload, not an oversight. `WebhookEvent` has exactly
 * one "outcome detail" column, and adding a second (`ignoreReason Json?`, say) purely so
 * `error` could stay literally error-shaped would be schema churn for a distinction that
 * does not change how the column is used: in both cases it is "why did the row land in
 * its terminal status", read only by an operator or the sweeper, never by application
 * logic that branches on its shape. Recorded here so a future reader of this table does
 * not mistake a `{ reason: "EDITED_METADATA_ONLY" }` value in `error` for a bug.
 */
export async function markIgnored(id: string, reason: string): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id },
    data: { status: IGNORED, error: { reason } },
  });
}

/** `PENDING → FAILED`. Reserved for a malformed-but-authentically-signed payload — a
 * condition that will never succeed on retry, per §11's state table. Never used for a
 * dispatch failure; see `webhook.service.ts`'s own comment on why that stays `PENDING`. */
export async function markFailed(id: string, error: { code: string; message: string }): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id },
    data: { status: FAILED, error },
  });
}

/**
 * Writes the *resolved* dispatch payload while the row is still `PENDING` — a separate
 * call from `markDispatched`, made **before** the Inngest send, not after. The payload
 * must be durable before the send is attempted so the sweeper (Prompt 4) can retry a
 * send that never returned (crashed process, timed-out request) without having to
 * re-run tenant resolution, which could legitimately produce a different fan-out by the
 * time the sweeper runs (a repository connected or disconnected in between). See the
 * schema's own `WebhookEvent.dispatchPayload` comment for the fuller argument.
 */
export async function savePendingDispatchPayload(id: string, dispatchPayload: unknown): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id },
    data: { dispatchPayload: dispatchPayload as object },
  });
}

/**
 * The most recent deliveries recorded for a GitHub repository, newest first.
 *
 * **Keyed on `repositoryFullName`, not a repository id — this function is not
 * owner-scoped, and that is intentional, not a gap.** `WebhookEvent` carries no
 * repository FK by design (see the schema's header comment): a single delivery can fan
 * out to repository rows under different projects, so there is no one `repositoryId` to
 * filter by even if the column existed. Two projects that both connected the same
 * GitHub repository see the same delivery list here, which is correct — the delivery
 * genuinely was for that GitHub repository, addressed to both.
 *
 * **The caller is responsible for proving it owns a repository with this `fullName`
 * before calling this function** — exactly the same division of responsibility
 * `repository.repository.ts`'s `findOwnershipById` documents for itself. This function
 * answers "what happened for this GitHub repository", not "what may this caller see".
 */
export async function listRecentByRepositoryFullName(fullName: string, limit: number): Promise<WebhookEventRecord[]> {
  return prisma.webhookEvent.findMany({
    where: { repositoryFullName: fullName },
    select: WEBHOOK_EVENT_SELECT,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** The subset of a `WebhookEvent` row the sweeper (Prompt 4) needs to retry a dispatch
 * that never completed: enough to re-send `dispatchPayload` and to log which delivery
 * it was retrying. */
export interface PendingDispatchRecord {
  id: string;
  deliveryId: string;
  eventType: string;
  dispatchPayload: unknown;
  createdAt: Date;
}

/**
 * Rows stuck `PENDING` for at least `ms` milliseconds — the sweeper's retry target
 * (Prompt 4), matching the `stale-index-sweeper` pattern Phase 03 already established
 * for `Repository`/`IndexJob`. `@@index([status, createdAt])` exists on this table
 * specifically for this query.
 */
export async function findPendingOlderThan(ms: number, limit: number): Promise<PendingDispatchRecord[]> {
  return prisma.webhookEvent.findMany({
    where: { status: PENDING, createdAt: { lt: new Date(Date.now() - ms) } },
    select: { id: true, deliveryId: true, eventType: true, dispatchPayload: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}
