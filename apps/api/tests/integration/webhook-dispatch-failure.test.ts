import { prisma } from "@repo/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "./db-helpers.js";
import { loadWebhookFixture, newDeliveryId, postWebhook, seedWebhookTenant } from "./webhook-helpers.js";

/**
 * Sub-task 5.5, Half A — §14 Failure Verification: "Simulate an Inngest send failure and
 * confirm the row stays PENDING and the sweeper picks it up within a minute." This file
 * is the API-side half of that: it proves the row this delivery leaves behind is exactly
 * what `apps/worker`'s sweeper (Half B, `apps/worker/tests/integration/
 * webhook-sweeper.test.ts`) needs to find and complete. The two files are deliberately
 * split by deployable, matching how the real system is split — nothing here drives the
 * sweeper itself.
 *
 * The mocked emitter rejects, simulating exactly the failure
 * `emitPullRequestReviewRequested` itself already turns a real Inngest outage or timeout
 * into (`emit.ts`'s own header comment: a timeout is `{ ok: false }`, indistinguishable
 * from here). `webhooks.controller.ts` adapts that `{ ok: false }` into a thrown error for
 * `webhook.service.ts`'s `try/catch` — reproduced directly here rather than re-mocking
 * `emitPullRequestReviewRequested`'s own `EmitResult` shape, since the dispatcher
 * interface `ingestDelivery` actually depends on is `WebhookDispatcher.send`, which
 * throws.
 */

vi.mock("../../src/inngest/emit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/inngest/emit.js")>();
  return { ...actual, emitPullRequestReviewRequested: vi.fn() };
});

const { emitPullRequestReviewRequested } = await import("../../src/inngest/emit.js");
const { default: app } = await import("../../src/app.js");

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(emitPullRequestReviewRequested).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/webhooks/github — a failed Inngest send", () => {
  it("still returns 200 to GitHub, leaves the row PENDING (not FAILED, not DISPATCHED) with dispatchPayload already populated, and still persists the PullRequest row", async () => {
    vi.mocked(emitPullRequestReviewRequested).mockResolvedValue({ ok: false, error: "simulated Inngest outage" });

    const tenant = await seedWebhookTenant();
    const { text } = loadWebhookFixture("pull-request-opened.json", { installationId: Number(tenant.installationId) });
    const deliveryId = newDeliveryId();

    const res = await postWebhook(app, { body: text, event: "pull_request", deliveryId });

    // GitHub must not be told to retry a delivery that is already durably queued for the
    // sweeper — a 5xx here would cause exactly the retry storm §12/§14.1 rules out.
    expect(res.status).toBe(200);

    const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { deliveryId } });
    expect(event.status).toBe("PENDING");
    expect(event.dispatchedAt).toBeNull();
    // The ordering assertion that actually matters (this file's header comment, and
    // webhook-event.repository.ts's own savePendingDispatchPayload doc comment): the
    // payload was written durably BEFORE the send was attempted, not after. A service
    // that wrote it only on success would leave this null on every failed dispatch,
    // making the row un-sweepable — exactly the UNSWEEPABLE_DISPATCH_PAYLOAD case
    // webhook-sweeper.ts's buildSweepSends exists to catch, but for every failure instead
    // of only a crash between insertPending and this write.
    expect(event.dispatchPayload).not.toBeNull();
    expect(Array.isArray(event.dispatchPayload)).toBe(true);
    expect((event.dispatchPayload as unknown[])[0]).toMatchObject({
      repositoryId: tenant.repositoryId,
      projectId: tenant.projectId,
      prKey: `${tenant.repositoryId}:42:6dcb09b5b57875f334f61aebed695e2e4193db5`,
    });

    const pr = await prisma.pullRequest.findUniqueOrThrow({ where: { repositoryId_number: { repositoryId: tenant.repositoryId, number: 42 } } });
    expect(pr.headSha).toBe("6dcb09b5b57875f334f61aebed695e2e4193db5");
  });
});
