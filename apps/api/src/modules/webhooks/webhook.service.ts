import { createLogger } from "@repo/observability";
import type {
  PullRequestClosedData,
  PullRequestReviewRequestedData,
} from "@repo/shared";
import { InternalError } from "../../lib/errors.js";
import * as repositoryRepository from "../repositories/repository.repository.js";
import { routePullRequestEvent, type IgnoreReason } from "./event-router.js";
import {
  syncInstallationEvent,
  syncInstallationRepositoriesEvent,
  syncRepositoryEvent,
} from "./installation-sync.js";
import * as pullRequestRepository from "./pull-request.repository.js";
import {
  extractAction,
  extractInstallationId,
  extractRepositoryFullName,
  installationEventSchema,
  installationRepositoriesEventSchema,
  pullRequestEventSchema,
  repositoryEventSchema,
} from "./webhook.schema.js";
import * as webhookEventRepository from "./webhook-event.repository.js";

/**
 * Orchestration for `POST /api/webhooks/github` (the HTTP endpoint itself is Prompt
 * 3's). This is the one place that knows the *order* verification, dedup, fan-out,
 * routing, persistence, and dispatch happen in — every other file this phase built is
 * either pure (`event-router.ts`) or a thin Prisma accessor with no opinion on
 * sequencing.
 *
 * Deliberately not pure, unlike the router: this module calls the repository layers and
 * logs. It does **not** import an Inngest client, though — `WebhookDispatcher` is taken
 * as an injected dependency so Prompt 3 can wire the real sender and unit tests here
 * can inject a stub, including one that throws, to exercise the `PENDING` retry path
 * without a live Inngest connection.
 *
 * ## DB statement budget (phase-06 §3.4 / plan.md §14.1)
 *
 * plan.md §14.1 budgets "~4 statements" for this path. The happy path here runs six:
 * `insertPending`, `findConnectedByGithubRepoId`, one `upsertMinimal` per tenant (1-2 in
 * practice), `savePendingDispatchPayload`, and `markDispatched`. The excess is the fan-
 * out query plus the per-tenant upsert loop, neither of which the budget's author could
 * have sized without knowing the fan-out would be multi-row — both are one round trip
 * each regardless of tenant count except the upsert loop itself, so the real, binding
 * constraint is the measured p99 (Prompt 5), not matching an estimate made before this
 * table's access pattern existed.
 */

const logger = createLogger("webhook");

export interface WebhookDispatcher {
  send(events: readonly PullRequestReviewRequestedData[]): Promise<void>;
  /** Phase 07 sub-task 1.3 — the `pull-request/closed` counterpart to `send` above,
   * exercised by the `PERSIST_AND_CANCEL` branch below. */
  sendClosed(events: readonly PullRequestClosedData[]): Promise<void>;
}

export type IngestOutcome =
  | { status: "DISPATCHED"; eventCount: number }
  | { status: "CANCELLED"; eventCount: number }
  | { status: "DUPLICATE" }
  | { status: "IGNORED"; reason: IgnoreReason }
  | { status: "PENDING"; reason: "DISPATCH_FAILED" }
  | { status: "FAILED"; code: string };

/**
 * The ordering below is the entire reason this function exists; see the file header.
 * Each numbered step corresponds to phase-06-webhook-ingestion.md §2 Prompt 2's own
 * enumeration — kept in the same order here so the two can be read side by side.
 */
export async function ingestDelivery(args: {
  deliveryId: string;
  eventType: string;
  /** Already `JSON.parse`'d by the controller (Prompt 3) — this module never touches
   * raw bytes, that is `webhook-verification.ts`'s job, upstream of this call. */
  rawPayload: unknown;
  traceId: string;
  dispatcher: WebhookDispatcher;
}): Promise<IngestOutcome> {
  const { deliveryId, eventType, rawPayload, traceId, dispatcher } = args;
  const startedAt = Date.now();

  if (eventType === "ping" || eventType === "push") {
    return ingestInertEvent({
      deliveryId,
      eventType,
      rawPayload,
      reason: eventType === "ping" ? "PING" : "PUSH_NOT_HANDLED_IN_MVP",
      startedAt,
    });
  }

  if (eventType !== "pull_request") {
    // `installation`, `installation_repositories`, and `repository` deliveries are
    // Prompt 4's sync orchestration — a separate service, invoked by the controller
    // directly for those event types, not routed through this function. Reaching here
    // with one of them (or with an event `isAllowedEvent` would reject) is a caller
    // mistake in how Prompt 3's controller dispatches by event type, not a client
    // condition — a 500 surfaces the bug rather than silently mishandling the delivery.
    throw new InternalError(
      `webhook ingestion service called with an unhandled event type: ${eventType}`,
    );
  }

  // Step 1 — parse. A failure here is a malformed-but-authentically-signed delivery
  // (the caller already verified the signature before calling this function): distinct
  // from a dispatch failure, and terminal — it goes to FAILED, never PENDING.
  const parsed = pullRequestEventSchema.safeParse(rawPayload);

  if (!parsed.success) {
    return ingestMalformedPullRequestEvent({
      deliveryId,
      eventType,
      rawPayload,
      parseErrorMessage: parsed.error.message,
      startedAt,
    });
  }

  const payload = parsed.data;

  // Step 2 — the dedup gate. Must come before any other write: no fan-out, no upsert,
  // no send happens until this delivery is proven not-a-duplicate.
  const inserted = await webhookEventRepository.insertPending({
    deliveryId,
    eventType,
    action: payload.action,
    installationId: payload.installation.id,
    repositoryFullName: payload.repository.full_name,
  });

  if (!inserted.ok) {
    logger.info("webhook delivery ignored: duplicate delivery", {
      deliveryId,
      eventType,
      action: payload.action,
      status: "DUPLICATE",
      latencyMs: Date.now() - startedAt,
    });
    return { status: "DUPLICATE" };
  }

  const webhookEventId = inserted.id;
  const baseLogFields = {
    deliveryId,
    eventType,
    action: payload.action,
    installationId: payload.installation.id.toString(),
  };

  // Step 3 — fan-out: every tenant this GitHub repository resolves to.
  const tenants = await repositoryRepository.findConnectedByGithubRepoId(
    payload.repository.id,
  );

  // Step 4 — the pure routing decision.
  const decision = routePullRequestEvent({ payload, tenants, traceId });

  // Step 5 — apply upserts. DISPATCH, PERSIST_ONLY, and PERSIST_AND_CANCEL all carry
  // them; IGNORE has none (it is only reached with zero tenants, so there is nothing to
  // upsert regardless).
  if (decision.kind !== "IGNORE") {
    for (const upsert of decision.pullRequestUpserts) {
      await pullRequestRepository.upsertMinimal(upsert);
    }
  }

  // Step 6.
  if (decision.kind === "IGNORE" || decision.kind === "PERSIST_ONLY") {
    await webhookEventRepository.markIgnored(webhookEventId, decision.reason);
    logger.info("webhook delivery ignored", {
      ...baseLogFields,
      status: "IGNORED",
      reason: decision.reason,
      latencyMs: Date.now() - startedAt,
    });
    return { status: "IGNORED", reason: decision.reason };
  }

  // Step 6b — Phase 07 sub-task 1.3. A `closed` delivery: the PR upsert already applied
  // above, and now the per-tenant cancellation events. **Deliberately not routed through
  // the PENDING/dispatchPayload retry path** steps 7-10 below use for a review dispatch:
  // `webhook-sweeper.ts` (apps/worker) re-sends a PENDING row's `dispatchPayload` verbatim
  // as `pull-request/review.requested` — replaying a failed *cancel* through that exact
  // mechanism would misinterpret `PullRequestClosedData` as `PullRequestReviewRequestedData`
  // and emit a spurious review request for the PR that just closed, which is exactly
  // backwards. A failed send is therefore logged at `error` (this event's cost of being
  // silently dropped is real — see `emitPullRequestClosed`'s own doc comment) and the row
  // still resolves to IGNORED; a dedicated cancel-retry path (paralleling the review-
  // dispatch sweeper) is a later prompt's scope, not this one's.
  if (decision.kind === "PERSIST_AND_CANCEL") {
    try {
      await dispatcher.sendClosed(decision.closedEvents);
    } catch (err) {
      logger.error("webhook cancel dispatch failed", {
        ...baseLogFields,
        status: "IGNORED",
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      await webhookEventRepository.markIgnored(webhookEventId, decision.reason);
      return { status: "IGNORED", reason: decision.reason };
    }

    await webhookEventRepository.markIgnored(webhookEventId, decision.reason);
    logger.info("webhook delivery ignored: pull request closed, cancel dispatched", {
      ...baseLogFields,
      status: "CANCELLED",
      eventCount: decision.closedEvents.length,
      latencyMs: Date.now() - startedAt,
    });
    return { status: "CANCELLED", eventCount: decision.closedEvents.length };
  }

  // Step 7 — durable before the send, so the sweeper (Prompt 4) can retry a send that
  // never returned without re-running tenant resolution.
  await webhookEventRepository.savePendingDispatchPayload(
    webhookEventId,
    decision.events,
  );

  // Step 8.
  try {
    await dispatcher.send(decision.events);
  } catch (err) {
    // Step 10 — a dispatch failure is retriable, and §11's state table reserves FAILED
    // for a payload that will never succeed. Do nothing to the row here: it stays
    // PENDING, exactly as inserted, so the sweeper finds it. Marking it FAILED would
    // make it invisible to the retry sweep for a failure that is, by construction, not
    // permanent.
    logger.error(
      "webhook dispatch failed; delivery stays PENDING for the sweeper",
      {
        ...baseLogFields,
        status: "PENDING",
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return { status: "PENDING", reason: "DISPATCH_FAILED" };
  }

  // Step 9.
  await webhookEventRepository.markDispatched(webhookEventId, decision.events);
  logger.info("webhook delivery dispatched", {
    ...baseLogFields,
    status: "DISPATCHED",
    eventCount: decision.events.length,
    latencyMs: Date.now() - startedAt,
  });
  return { status: "DISPATCHED", eventCount: decision.events.length };
}

/**
 * `ping`/`push` share one path: both are allow-listed with no handler
 * (`event-allowlist.ts`'s own header comment), so both are recorded for the audit
 * ledger and immediately marked `IGNORED` with a distinct reason — no parsing, no
 * fan-out, no router involvement, because neither event type carries anything this
 * phase acts on.
 */
async function ingestInertEvent(params: {
  deliveryId: string;
  eventType: "ping" | "push";
  rawPayload: unknown;
  reason: Extract<IgnoreReason, "PING" | "PUSH_NOT_HANDLED_IN_MVP">;
  startedAt: number;
}): Promise<IngestOutcome> {
  const { deliveryId, eventType, rawPayload, reason, startedAt } = params;
  const installationId = extractInstallationId(rawPayload);
  const repositoryFullName = extractRepositoryFullName(rawPayload);

  const inserted = await webhookEventRepository.insertPending({
    deliveryId,
    eventType,
    action: null,
    installationId,
    repositoryFullName,
  });

  if (!inserted.ok) {
    logger.info("webhook delivery ignored: duplicate delivery", {
      deliveryId,
      eventType,
      status: "DUPLICATE",
      latencyMs: Date.now() - startedAt,
    });
    return { status: "DUPLICATE" };
  }

  await webhookEventRepository.markIgnored(inserted.id, reason);
  logger.info("webhook delivery ignored", {
    deliveryId,
    eventType,
    action: null,
    installationId: installationId?.toString() ?? null,
    status: "IGNORED",
    reason,
    latencyMs: Date.now() - startedAt,
  });
  return { status: "IGNORED", reason };
}

/**
 * Step 1's failure branch. `insertPending` is called here too — a malformed delivery is
 * still auditable — but this is a **second, independent** call site from step 2's, not
 * a shared one: a payload that fails to parse never reaches step 2 at all, so there is
 * exactly one `insertPending` call on any given path through this file.
 */
async function ingestMalformedPullRequestEvent(params: {
  deliveryId: string;
  eventType: string;
  rawPayload: unknown;
  parseErrorMessage: string;
  startedAt: number;
}): Promise<IngestOutcome> {
  const { deliveryId, eventType, rawPayload, parseErrorMessage, startedAt } =
    params;
  const installationId = extractInstallationId(rawPayload);
  const repositoryFullName = extractRepositoryFullName(rawPayload);

  const inserted = await webhookEventRepository.insertPending({
    deliveryId,
    eventType,
    action: extractAction(rawPayload),
    installationId,
    repositoryFullName,
  });

  if (!inserted.ok) {
    // The malformed delivery itself was redelivered; the first attempt's row already
    // recorded it (in whatever status that attempt reached). Nothing new to write.
    logger.info("webhook delivery ignored: duplicate delivery", {
      deliveryId,
      eventType,
      status: "DUPLICATE",
      latencyMs: Date.now() - startedAt,
    });
    return { status: "DUPLICATE" };
  }

  const code = "MALFORMED_PAYLOAD";
  await webhookEventRepository.markFailed(inserted.id, {
    code,
    message: parseErrorMessage,
  });

  logger.error(
    "webhook delivery failed: malformed payload after a valid signature",
    {
      deliveryId,
      eventType,
      installationId: installationId?.toString() ?? null,
      status: "FAILED",
      latencyMs: Date.now() - startedAt,
      error: parseErrorMessage,
    },
  );

  return { status: "FAILED", code };
}

// ---------------------------------------------------------------------------
// Prompt 4 — installation / installation_repositories / repository sync.
// installation-sync.ts owns the decision table; this is only the same dedup →
// parse → route → terminal-status sequencing ingestDelivery already uses above,
// applied to the three sync event types the controller routes here instead.
// ---------------------------------------------------------------------------

export type SyncEventType =
  "installation" | "installation_repositories" | "repository";

export type SyncIngestOutcome =
  | { status: "IGNORED"; reason: string }
  | { status: "DUPLICATE" }
  | { status: "FAILED"; code: string };

/**
 * `installation`/`installation_repositories`/`repository` deliveries never dispatch an
 * Inngest event — `installation-sync.ts`'s own header comment argues why they resolve to
 * `IGNORED`, not a fifth `WebhookEventStatus`. Still recorded in the `WebhookEvent` audit
 * ledger and covered by the same `deliveryId` dedup gate `ingestDelivery` uses above, for
 * the identical reason: a GitHub redelivery of a sync event must not be applied twice.
 */
export async function ingestSyncDelivery(args: {
  deliveryId: string;
  eventType: SyncEventType;
  /** Already `JSON.parse`'d by the controller — see `ingestDelivery`'s identical note. */
  rawPayload: unknown;
}): Promise<SyncIngestOutcome> {
  const { deliveryId, eventType, rawPayload } = args;
  const startedAt = Date.now();

  const installationId = extractInstallationId(rawPayload);
  const repositoryFullName = extractRepositoryFullName(rawPayload);
  const action = extractAction(rawPayload);

  const inserted = await webhookEventRepository.insertPending({
    deliveryId,
    eventType,
    action,
    installationId,
    repositoryFullName,
  });

  if (!inserted.ok) {
    logger.info("webhook delivery ignored: duplicate delivery", {
      deliveryId,
      eventType,
      status: "DUPLICATE",
      latencyMs: Date.now() - startedAt,
    });
    return { status: "DUPLICATE" };
  }

  let outcome: { reason: string };

  switch (eventType) {
    case "installation": {
      const parsed = installationEventSchema.safeParse(rawPayload);
      if (!parsed.success) {
        return failSyncDelivery(
          inserted.id,
          deliveryId,
          eventType,
          parsed.error.message,
          startedAt,
        );
      }
      outcome = await syncInstallationEvent(parsed.data);
      break;
    }
    case "installation_repositories": {
      const parsed = installationRepositoriesEventSchema.safeParse(rawPayload);
      if (!parsed.success) {
        return failSyncDelivery(
          inserted.id,
          deliveryId,
          eventType,
          parsed.error.message,
          startedAt,
        );
      }
      outcome = await syncInstallationRepositoriesEvent(parsed.data);
      break;
    }
    case "repository": {
      const parsed = repositoryEventSchema.safeParse(rawPayload);
      if (!parsed.success) {
        return failSyncDelivery(
          inserted.id,
          deliveryId,
          eventType,
          parsed.error.message,
          startedAt,
        );
      }
      outcome = await syncRepositoryEvent(parsed.data);
      break;
    }
  }

  await webhookEventRepository.markIgnored(inserted.id, outcome.reason);
  logger.info("webhook delivery ignored: sync applied, no dispatch", {
    deliveryId,
    eventType,
    action,
    status: "IGNORED",
    reason: outcome.reason,
    latencyMs: Date.now() - startedAt,
  });
  return { status: "IGNORED", reason: outcome.reason };
}

/** Step 1's failure branch for the sync path — a second, independent `insertPending`
 * call site from `ingestMalformedPullRequestEvent`'s, mirroring its own reasoning: a
 * malformed-but-authentically-signed sync delivery is still auditable, and terminal
 * (`FAILED`, never retried) for the same reason a malformed `pull_request` payload is. */
async function failSyncDelivery(
  id: string,
  deliveryId: string,
  eventType: SyncEventType,
  parseErrorMessage: string,
  startedAt: number,
): Promise<SyncIngestOutcome> {
  const code = "MALFORMED_PAYLOAD";
  await webhookEventRepository.markFailed(id, {
    code,
    message: parseErrorMessage,
  });

  logger.error(
    "webhook delivery failed: malformed payload after a valid signature",
    {
      deliveryId,
      eventType,
      status: "FAILED",
      latencyMs: Date.now() - startedAt,
      error: parseErrorMessage,
    },
  );

  return { status: "FAILED", code };
}
