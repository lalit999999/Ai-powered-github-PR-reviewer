import type { Request, Response } from "express";
import { createLogger, getTraceId } from "@repo/observability";
import { env } from "../config/env.js";
import { emitPullRequestReviewRequested } from "../inngest/emit.js";
import { UnauthenticatedError, ValidationError } from "../lib/errors.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { isAllowedEvent } from "../modules/webhooks/event-allowlist.js";
import { WEBHOOK_RATE_LIMIT_PER_INSTALLATION, WEBHOOK_RATE_LIMIT_WINDOW_SECONDS } from "../modules/webhooks/webhook-rate-limit.js";
import { verifyWebhookSignature } from "../modules/webhooks/webhook-verification.js";
import { extractInstallationId } from "../modules/webhooks/webhook.schema.js";
import * as webhookService from "../modules/webhooks/webhook.service.js";
import type { WebhookDispatcher } from "../modules/webhooks/webhook.service.js";

const logger = createLogger("api.webhooks");

/**
 * `POST /api/webhooks/github` — the one route in this codebase with **no
 * `requireSession` and no `requireTenantAccess`**, and that absence is correct, not an
 * oversight. Every other controller in this codebase is the same four steps —
 * authenticate a human via a cookie, resolve tenancy from *their* identity, validate,
 * delegate (`repositories.controller.ts`'s own header comment) — and a reader who knows
 * that convention will notice the missing calls immediately. This route is authenticated
 * by an HMAC over the raw request body instead: the caller is GitHub, not a signed-in
 * user, and tenancy is resolved inside the service, from the database, by
 * `installationId`/`githubRepoId` — not from anyone's session, because there isn't one.
 *
 * The four steps this route actually takes: **verify signature → allow-list check →
 * rate limit → delegate to the service.**
 */
export async function receiveGithubWebhook(req: Request, res: Response): Promise<void> {
  // requestContext (app.ts, mounted first) has already established this request's
  // traceId before any route runs. Generating a second one here would break
  // correlation between this request's log lines and the worker's own, once the trace
  // crosses into Inngest (job-tracking.ts, Prompt 3.4).
  const traceId = getTraceId() ?? "no-trace-context";

  // app.ts's own comment at the raw-body mount records, empirically, that req.body is
  // not guaranteed to be a Buffer — an absent Content-Type with no body at all leaves it
  // `undefined`. Treated as an empty body rather than special-cased: it will simply fail
  // signature verification below, which is the correct outcome for a request that was
  // never a real GitHub delivery in the first place.
  const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  const deliveryId = req.header("x-github-delivery");
  const eventType = req.header("x-github-event");
  const signatureHeader = req.header("x-hub-signature-256");

  if (!deliveryId || !eventType) {
    logger.warn("webhook rejected: missing delivery headers", {
      outcome: "MISSING_HEADERS",
      hasDeliveryId: Boolean(deliveryId),
      hasEventType: Boolean(eventType),
    });
    throw new ValidationError("Missing x-github-delivery or x-github-event header");
  }

  const verification = verifyWebhookSignature(rawBody, signatureHeader, env.GITHUB_APP_WEBHOOK_SECRET);
  if (!verification.ok) {
    // §4 Security / §20: a dedicated, queryable outcome value — a spike here is the
    // signal for a rotated or leaked secret, and it must be distinguishable from every
    // other rejection at query time, not by eyeballing free-text log messages.
    logger.warn("webhook signature rejected", {
      outcome: "SIGNATURE_REJECTED",
      reason: verification.reason,
      deliveryId,
      eventType,
    });
    throw new UnauthenticatedError("Invalid webhook signature");
  }

  if (!isAllowedEvent(eventType)) {
    // event-allowlist.ts's own header comment reconciles this: "rejected" means no row,
    // no dispatch — not a non-200 status, which would only teach GitHub to retry a
    // delivery this server has no intention of ever handling differently.
    logger.warn("webhook ignored: event type not allow-listed", { outcome: "UNKNOWN_EVENT", deliveryId, eventType });
    res.status(200).json({ received: true });
    return;
  }

  if (eventType === "ping") {
    logger.info("webhook acknowledged: ping", { outcome: "PING", deliveryId });
    res.status(200).json({ received: true });
    return;
  }

  // From here on eventType is narrowed to every allow-listed type except "ping" —
  // "installation" | "installation_repositories" | "repository" | "pull_request" | "push".

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    // Malformed body after a *valid* signature: the sender proved it holds the secret,
    // so this is an authentic-but-broken delivery, not tampering — 400, not 401.
    logger.warn("webhook rejected: body is not valid JSON after a valid signature", {
      outcome: "INVALID_JSON",
      deliveryId,
      eventType,
    });
    throw new ValidationError("Webhook payload is not valid JSON");
  }

  // Rate-limited by installationId, extracted best-effort from the parsed payload via
  // webhook.schema.ts's extractInstallationId — the same never-throws helper
  // webhook.service.ts uses for audit metadata, reused here for a second legitimate
  // purpose. A payload with no extractable installation id shares one fallback bucket
  // rather than skipping the limit entirely, so a flood of installation-less garbage
  // stays bounded too. Applies uniformly to every event type reaching this point,
  // including the three sync types below — a compromised secret replaying installation
  // sync deliveries is exactly the flood this guard exists to bound.
  const installationId = extractInstallationId(payload);
  const rateLimitKey = `webhook:installation:${installationId?.toString() ?? "unknown"}`;
  const rate = await checkRateLimit(rateLimitKey, WEBHOOK_RATE_LIMIT_PER_INSTALLATION, WEBHOOK_RATE_LIMIT_WINDOW_SECONDS);

  if (!rate.allowed) {
    // 200, not 429: a 429 to GitHub triggers redelivery, which is precisely the flood
    // this guard exists to stop (§4/§13). Nothing is persisted — this request never
    // reaches ingestDelivery/ingestSyncDelivery, so no WebhookEvent row is written for it.
    logger.warn("webhook rate-limited", {
      outcome: "RATE_LIMITED",
      deliveryId,
      eventType,
      installationId: installationId?.toString() ?? null,
      retryAfterSeconds: rate.retryAfterSeconds,
    });
    res.status(200).json({ received: true });
    return;
  }

  if (eventType === "installation" || eventType === "installation_repositories" || eventType === "repository") {
    // Prompt 4's sync orchestration — a separate path from ingestDelivery below, which
    // only ever handles pull_request/push. installation-sync.ts's own header comment has
    // the full event/action table this delegates to.
    //
    // ingestSyncDelivery logs its own outcome (IGNORED/DUPLICATE/FAILED) at the level
    // appropriate to that outcome — nothing further to log here.
    await webhookService.ingestSyncDelivery({ deliveryId, eventType, rawPayload: payload });
    res.status(200).json({ received: true });
    return;
  }

  // From here on eventType is narrowed to "pull_request" | "push" — the two types
  // webhook.service.ingestDelivery actually handles.

  // Adapts emitPullRequestReviewRequested's EmitResult (inspected, never thrown) onto
  // WebhookDispatcher's throw-on-failure contract, which webhook.service.ts's own
  // try/catch already expects — a failed send must surface as a rejection here for the
  // row to correctly stay PENDING for the sweeper (Prompt 4) rather than being marked
  // dispatched or failed.
  const dispatcher: WebhookDispatcher = {
    async send(events) {
      const result = await emitPullRequestReviewRequested(events);
      if (!result.ok) {
        throw new Error(result.error);
      }
    },
  };

  // ingestDelivery logs its own outcome (DISPATCHED/DUPLICATE/IGNORED/PENDING/FAILED) at
  // the level appropriate to that outcome — nothing further to log here.
  await webhookService.ingestDelivery({ deliveryId, eventType, rawPayload: payload, traceId, dispatcher });

  // Always 200, for every outcome the service can return. A 5xx would make GitHub retry
  // a delivery that either failed for a reason no retry fixes (a malformed payload) or
  // is already durably queued for the sweeper to retry (a dispatch failure) — either way
  // a retry storm, not a recovery (§12/§14.1). The sweeper provides the resilience
  // instead of the HTTP status code.
  res.status(200).json({ received: true });
}
