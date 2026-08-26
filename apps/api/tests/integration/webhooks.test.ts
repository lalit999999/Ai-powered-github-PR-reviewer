import { prisma } from "@repo/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "./db-helpers.js";
import {
  loadWebhookFixture,
  newDeliveryId,
  postWebhook,
  seedSecondProjectForSameRepo,
  seedWebhookTenant,
  signWebhookBody,
} from "./webhook-helpers.js";

/**
 * `POST /api/webhooks/github` driven end to end through the real Express app (real
 * `app.ts`, real raw-body mount, real routing) with a real Postgres — the same
 * `repositories.test.ts` discipline this suite follows. GitHub itself never enters the
 * picture (there is no GitHub client anywhere on this route — Rule D, Prompt 3); the one
 * thing mocked is the Inngest emitter, at the exact boundary `repositories.test.ts`
 * mocks its own emit calls (`../../src/inngest/emit.js`), for the identical reason: no
 * real Inngest connection exists in this environment, and this suite's job is the
 * route → verification → dedup → fan-out → routing → persistence pipeline, not Inngest's
 * own delivery.
 *
 * **Scope, stated explicitly (phase-06 §0 rule 6 — a test that cannot fail is worse than
 * no test):**
 * - This file proves the HTTP-to-Postgres pipeline for `pull_request` deliveries. The
 *   `installation`/`installation_repositories`/`repository` sync paths (Prompt 4) are
 *   unit-tested directly in `installation-sync.test.ts` against a mocked repository
 *   layer — that is a deliberate, already-made choice this file does not re-litigate;
 *   Sub-task 5.4 adds a thin proof that this route's zero-GitHub-API-calls property holds
 *   for a real delivery.
 * - This file does **not** prove the Inngest send itself succeeds against a real Inngest
 *   Cloud/Dev Server connection — no such connection exists in this environment
 *   (`docs/decisions/phase-02-log.md` §14 and every phase log since). The dispatcher is
 *   mocked; `webhook-dispatch-failure.test.ts` (sub-task 5.5) exercises what happens when
 *   that mock rejects.
 * - The signature-verification cases below are the actual defense against a forged
 *   delivery, so they are driven through the real HTTP layer with an
 *   **independently-computed** signature (`webhook-helpers.ts`'s own header comment) —
 *   not asserted against `verifyWebhookSignature` directly, which is already unit-tested
 *   in `webhook-verification.test.ts` and would not catch a body-corruption bug in the
 *   route wiring the way this file's tests do.
 */

vi.mock("../../src/inngest/emit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/inngest/emit.js")>();
  return { ...actual, emitPullRequestReviewRequested: vi.fn() };
});

const { emitPullRequestReviewRequested } = await import("../../src/inngest/emit.js");
const { default: app } = await import("../../src/app.js");

const WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET ?? "local-dev-webhook-secret";

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(emitPullRequestReviewRequested).mockReset();
  vi.mocked(emitPullRequestReviewRequested).mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function countRows(): Promise<{ webhookEvents: number; pullRequests: number }> {
  const [webhookEvents, pullRequests] = await Promise.all([prisma.webhookEvent.count(), prisma.pullRequest.count()]);
  return { webhookEvents, pullRequests };
}

// ═══════════════════════════════════════════════════════════════════════════════════
// Sub-task 5.2 — signature, size-cap, and unknown-event integration tests.
// ═══════════════════════════════════════════════════════════════════════════════════

describe("POST /api/webhooks/github — signature verification", () => {
  it("valid signature, valid payload, connected repository: 200, DISPATCHED row, PullRequest row, emitter called once", async () => {
    const tenant = await seedWebhookTenant();
    const { text } = loadWebhookFixture("pull-request-opened.json", { installationId: Number(tenant.installationId) });
    const deliveryId = newDeliveryId();

    const res = await postWebhook(app, { body: text, event: "pull_request", deliveryId });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { deliveryId } });
    expect(event.status).toBe("DISPATCHED");
    expect(event.eventType).toBe("pull_request");

    const pr = await prisma.pullRequest.findUniqueOrThrow({ where: { repositoryId_number: { repositoryId: tenant.repositoryId, number: 42 } } });
    expect(pr.headSha).toBe("6dcb09b5b57875f334f61aebed695e2e4193db5");
    expect(pr.isDraft).toBe(false);

    expect(emitPullRequestReviewRequested).toHaveBeenCalledTimes(1);
  });

  it("tampered body (valid signature for the ORIGINAL body): 401, nothing persisted", async () => {
    const tenant = await seedWebhookTenant();
    const { text } = loadWebhookFixture("pull-request-opened.json", { installationId: Number(tenant.installationId) });
    const signatureForOriginal = signWebhookBody(text, WEBHOOK_SECRET);
    const tamperedText = text.replace('"opened"', '"reopened"');
    expect(tamperedText).not.toBe(text); // sanity: the tamper actually changed the bytes

    const res = await postWebhook(app, {
      body: tamperedText,
      event: "pull_request",
      deliveryId: newDeliveryId(),
      signature: signatureForOriginal,
    });

    expect(res.status).toBe(401);
    const counts = await countRows();
    expect(counts).toEqual({ webhookEvents: 0, pullRequests: 0 });
    expect(emitPullRequestReviewRequested).not.toHaveBeenCalled();
  });

  it("tampered signature (one hex character changed): 401, nothing persisted", async () => {
    const tenant = await seedWebhookTenant();
    const { text } = loadWebhookFixture("pull-request-opened.json", { installationId: Number(tenant.installationId) });
    const validSignature = signWebhookBody(text, WEBHOOK_SECRET);
    const lastChar = validSignature.at(-1);
    const flipped = lastChar === "a" ? "b" : "a";
    const tamperedSignature = validSignature.slice(0, -1) + flipped;

    const res = await postWebhook(app, { body: text, event: "pull_request", deliveryId: newDeliveryId(), signature: tamperedSignature });

    expect(res.status).toBe(401);
    expect(await countRows()).toEqual({ webhookEvents: 0, pullRequests: 0 });
  });

  it("missing x-hub-signature-256 header: 401, nothing persisted", async () => {
    const tenant = await seedWebhookTenant();
    const { text } = loadWebhookFixture("pull-request-opened.json", { installationId: Number(tenant.installationId) });

    const res = await postWebhook(app, { body: text, event: "pull_request", deliveryId: newDeliveryId(), signature: null });

    expect(res.status).toBe(401);
    expect(await countRows()).toEqual({ webhookEvents: 0, pullRequests: 0 });
  });

  it("signature computed with the wrong secret: 401, nothing persisted", async () => {
    const tenant = await seedWebhookTenant();
    const { text } = loadWebhookFixture("pull-request-opened.json", { installationId: Number(tenant.installationId) });
    const wrongSecretSignature = signWebhookBody(text, "definitely-not-the-real-secret");

    const res = await postWebhook(app, { body: text, event: "pull_request", deliveryId: newDeliveryId(), signature: wrongSecretSignature });

    expect(res.status).toBe(401);
    expect(await countRows()).toEqual({ webhookEvents: 0, pullRequests: 0 });
  });

  it("does not break on irregular-but-valid JSON whitespace/key order — regression guard for the express.raw()/express.json() mount order", async () => {
    // Named so the reason is obvious on its own: if express.raw() at WEBHOOK_GITHUB_PATH
    // ever moves after express.json() (or is dropped in favor of express.json() "for
    // consistency"), Express's JSON body parser will have already reconstructed req.body
    // through a Buffer -> string -> object round trip by the time this handler runs,
    // changing whitespace/key order without changing the parsed value — silently
    // invalidating the signature this test computes over the ORIGINAL, irregular bytes.
    // This is app.ts's own header comment's named #1 failure mode (plan.md §45), given a
    // concrete, always-run regression test rather than left as a comment alone.
    const tenant = await seedWebhookTenant();
    const installationId = 60_555_001;
    const weirdBody = [
      "{",
      '  "action":   "opened",',
      '  "number": 42,',
      "  \"pull_request\":   {\"id\":1911415577,   \"number\":42,\"state\":\"open\",\"draft\":false,",
      '    "head":{"sha":"6dcb09b5b57875f334f61aebed695e2e4193db5"},',
      '    "base":{"sha":"6dcb09b5b57875f334f61aebed695e2e4193db4"}},',
      `  "repository": {"id":${tenant.githubRepoId.toString()},"full_name":"${tenant.fullName}","name":"hello-world","owner":{"login":"octocat"},"html_url":"https://github.com/${tenant.fullName}"},`,
      `  "installation":{"id":${installationId.toString()}}`,
      "}",
      "",
    ].join("\n");
    // Sanity: this is not what JSON.stringify(JSON.parse(weirdBody)) would produce —
    // proving the test actually exercises irregular formatting, not an accident of
    // regular formatting that happens to look unusual.
    expect(weirdBody).not.toBe(JSON.stringify(JSON.parse(weirdBody)));

    const res = await postWebhook(app, { body: weirdBody, event: "pull_request", deliveryId: newDeliveryId() });

    expect(res.status).toBe(200);
    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { installationId: BigInt(installationId) } });
    expect(event.status).toBe("DISPATCHED");
  });
});

describe("POST /api/webhooks/github — delivery headers", () => {
  it("missing x-github-delivery: 400", async () => {
    const { text } = loadWebhookFixture("pull-request-opened.json");
    const res = await postWebhook(app, { body: text, event: "pull_request" });
    expect(res.status).toBe(400);
    expect(await countRows()).toEqual({ webhookEvents: 0, pullRequests: 0 });
  });

  it("missing x-github-event: 400", async () => {
    const { text } = loadWebhookFixture("pull-request-opened.json");
    const res = await postWebhook(app, { body: text, deliveryId: newDeliveryId() });
    expect(res.status).toBe(400);
    expect(await countRows()).toEqual({ webhookEvents: 0, pullRequests: 0 });
  });
});

describe("POST /api/webhooks/github — unknown and inert event types", () => {
  it("unknown event type (issue_comment), correctly signed: 200, nothing persisted, emitter not called", async () => {
    const { text } = loadWebhookFixture("pull-request-opened.json");
    const res = await postWebhook(app, { body: text, event: "issue_comment", deliveryId: newDeliveryId() });

    expect(res.status).toBe(200);
    expect(await countRows()).toEqual({ webhookEvents: 0, pullRequests: 0 });
    expect(emitPullRequestReviewRequested).not.toHaveBeenCalled();
  });

  it("ping: 200, emitter not called, nothing persisted", async () => {
    const { text } = loadWebhookFixture("ping.json");
    const res = await postWebhook(app, { body: text, event: "ping", deliveryId: newDeliveryId() });

    expect(res.status).toBe(200);
    expect(await countRows()).toEqual({ webhookEvents: 0, pullRequests: 0 });
    expect(emitPullRequestReviewRequested).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/github — payload size cap", () => {
  it("a payload just over 5 MB: 400 (clean rejection, not a timeout or crash), nothing persisted", async () => {
    const { payload } = loadWebhookFixture("pull-request-opened.json");
    // Padding a real payload rather than constructing raw junk — this is what §14 asks
    // for: a body that is otherwise a legitimate delivery, just too large.
    (payload as Record<string, unknown>).padding = "x".repeat(6 * 1024 * 1024);
    const text = JSON.stringify(payload);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(5 * 1024 * 1024);

    const startedAt = Date.now();
    const res = await postWebhook(app, { body: text, event: "pull_request", deliveryId: newDeliveryId() });
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(400);
    expect(elapsedMs).toBeLessThan(10_000); // clean rejection, not a hang
    expect(await countRows()).toEqual({ webhookEvents: 0, pullRequests: 0 });
  }, 15_000);
});

describe("POST /api/webhooks/github — malformed payloads after a valid signature", () => {
  it("malformed JSON syntax: 400, nothing persisted — the controller's JSON.parse fails before any repository write is attempted", async () => {
    const { text } = loadWebhookFixture("pull-request-opened.json");
    const truncated = text.slice(0, -5); // breaks JSON syntax, still signable as-is

    const res = await postWebhook(app, { body: truncated, event: "pull_request", deliveryId: newDeliveryId() });

    expect(res.status).toBe(400);
    expect(await countRows()).toEqual({ webhookEvents: 0, pullRequests: 0 });
  });

  it("valid JSON that fails pull_request schema validation: 200 to the caller, but the row lands FAILED with MALFORMED_PAYLOAD — the OTHER malformed case §11's state table describes", async () => {
    // Distinct from the case above: this delivery IS valid JSON, so it reaches
    // webhook.service.ingestDelivery, which does its own insertPending before
    // discovering the schema mismatch (webhook.service.ts's ingestMalformedPullRequestEvent).
    // Recorded here explicitly since it is the branch phase-06 §11 actually names
    // ("malformed-but-authentically-signed") — the JSON-syntax case above never reaches
    // this far, and conflating the two would misrepresent which one the state table means.
    const { payload } = loadWebhookFixture("pull-request-opened.json");
    delete (payload as Record<string, unknown>).pull_request; // required by the schema
    const text = JSON.stringify(payload);
    const deliveryId = newDeliveryId();

    const res = await postWebhook(app, { body: text, event: "pull_request", deliveryId });

    expect(res.status).toBe(200); // never a 5xx that would make GitHub retry
    const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { deliveryId } });
    expect(event.status).toBe("FAILED");
    expect(event.error).toMatchObject({ code: "MALFORMED_PAYLOAD" });
    expect(await prisma.pullRequest.count()).toBe(0);
    expect(emitPullRequestReviewRequested).not.toHaveBeenCalled();
  });
});
