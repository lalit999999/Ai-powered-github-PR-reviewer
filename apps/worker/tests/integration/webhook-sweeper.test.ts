import { InngestTestEngine } from "@inngest/test";
import { prisma } from "@repo/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "./db-helpers.js";

/**
 * Sub-task 5.5, Half B — §14 Failure Verification's other half: "the sweeper picks it up
 * within a minute." Drives the real `webhookSweeper` `InngestFunction` object through
 * `@inngest/test`'s `InngestTestEngine` against a real Testcontainers Postgres, matching
 * `repository-index-pipeline.test.ts`'s own structure and its documented limitations
 * (read that file's header first — the same "no automatic retries, no automatic
 * onFailure" caveat applies here, though this function has no `onFailure` handler to
 * begin with).
 *
 * Rows are seeded directly through Prisma with a `createdAt` in the past — `@@default(now())`
 * cannot be overridden through the application's own repository functions (nothing in
 * this phase ever needs to backdate a row), so this is the one file in the suite that
 * writes `WebhookEvent.createdAt` directly, deliberately bypassing the app layer to
 * simulate "this row has been PENDING for a while" without an actual wall-clock wait.
 *
 * `step.sendEvent`'s underlying `inngest.send()` goes through the real Inngest client's
 * `fetch` — stubbed here for the identical reason `repository-index-pipeline.test.ts`
 * stubs it for its own `step.sendEvent("emit-repository-indexed", ...)` call: no real
 * Inngest connection exists in this environment, and a real network call is not what
 * this file is testing.
 */

const SAMPLE_EVENT_DATA = {
  projectId: "proj-sweeper-1",
  repositoryId: "repo-sweeper-1",
  installationId: "999",
  pullRequestNumber: 7,
  headSha: "abc123",
  baseSha: "def456",
  trigger: "opened" as const,
  traceId: "trace-sweeper-1",
  prKey: "repo-sweeper-1:7:abc123",
};

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await resetDatabase();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ids: ["evt_test"], status: 200 }), { status: 200 })),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", originalFetch);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const PENDING_THRESHOLD_MS = 60 * 1000;

async function seedWebhookEventRow(overrides: {
  deliveryId: string;
  ageMs: number;
  status?: "PENDING" | "DISPATCHED" | "IGNORED" | "FAILED";
  dispatchPayload?: unknown;
}) {
  return prisma.webhookEvent.create({
    data: {
      deliveryId: overrides.deliveryId,
      eventType: "pull_request",
      action: "opened",
      status: overrides.status ?? "PENDING",
      dispatchPayload: (overrides.dispatchPayload === undefined ? [SAMPLE_EVENT_DATA] : overrides.dispatchPayload) as object | undefined,
      createdAt: new Date(Date.now() - overrides.ageMs),
    },
  });
}

async function runSweeper() {
  const { webhookSweeper } = await import("../../src/inngest/functions/webhook-sweeper.js");
  // `webhookSweeper` is cron-triggered, not event-triggered — `events` is omitted
  // (optional on `InngestTestEngine`'s own options type) rather than passed as `[]`,
  // which the installed `@inngest/test@1.0.0`'s types reject: `events` is typed as a
  // non-empty tuple when present at all, since every other function in this codebase's
  // test suites (`repository-index-pipeline.test.ts`) is event-triggered and always has
  // at least one to pass.
  const t = new InngestTestEngine({ function: webhookSweeper });
  return t.execute();
}

describe("webhook-sweeper — the real InngestFunction, against real Postgres", () => {
  it("re-dispatches a PENDING row older than the threshold and marks it DISPATCHED", async () => {
    const row = await seedWebhookEventRow({ deliveryId: "old-pending-1", ageMs: PENDING_THRESHOLD_MS + 5_000 });

    const { result, error } = await runSweeper();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ found: 1, dispatched: 1, failed: 0 });

    const updated = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe("DISPATCHED");
    expect(updated.dispatchedAt).not.toBeNull();
  });

  it("does NOT touch a PENDING row younger than the threshold — the race guard against double-sending a request still in flight", async () => {
    const row = await seedWebhookEventRow({ deliveryId: "young-pending-1", ageMs: 5_000 });

    const { result, error } = await runSweeper();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ found: 0, dispatched: 0, failed: 0 });

    const untouched = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(untouched.status).toBe("PENDING");
    expect(untouched.dispatchedAt).toBeNull();
  });

  it("marks a row with a null dispatchPayload FAILED rather than retrying it forever", async () => {
    const row = await seedWebhookEventRow({ deliveryId: "null-payload-1", ageMs: PENDING_THRESHOLD_MS + 5_000, dispatchPayload: null });

    const { result, error } = await runSweeper();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ found: 1, dispatched: 0, failed: 1 });

    const updated = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.error).toMatchObject({ code: "UNSWEEPABLE_DISPATCH_PAYLOAD" });
  });

  it("never re-sends an already-DISPATCHED row", async () => {
    const row = await seedWebhookEventRow({ deliveryId: "already-dispatched-1", ageMs: PENDING_THRESHOLD_MS + 5_000, status: "DISPATCHED" });

    const { result, error } = await runSweeper();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ found: 0, dispatched: 0, failed: 0 });

    const untouched = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(untouched.status).toBe("DISPATCHED");
  });

  it("respects the batch limit when more rows are pending than the limit", async () => {
    const rows = await Promise.all(
      Array.from({ length: 60 }, (_, i) => seedWebhookEventRow({ deliveryId: `batch-${i.toString()}`, ageMs: PENDING_THRESHOLD_MS + 5_000 })),
    );

    const { result, error } = await runSweeper();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ found: 50, dispatched: 50, failed: 0 });

    const statuses = await prisma.webhookEvent.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { status: true } });
    const dispatchedCount = statuses.filter((s) => s.status === "DISPATCHED").length;
    const stillPendingCount = statuses.filter((s) => s.status === "PENDING").length;
    expect(dispatchedCount).toBe(50);
    expect(stillPendingCount).toBe(10);
  });
});
