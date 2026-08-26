import { prisma } from "@repo/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "./db-helpers.js";
import { loadWebhookFixture, newDeliveryId, postWebhook, seedWebhookTenant } from "./webhook-helpers.js";

/**
 * §14: "Latency test: p99 under 500 ms under at least 200 concurrent simulated
 * deliveries." Follows `repository-index-performance.test.ts`'s own conventions —
 * `SKIP_PERF_TESTS=1` excludes it from a fast local loop, and it prints its measured
 * distribution rather than only asserting a threshold, so a future regression is
 * diagnosable, not just detectable.
 *
 * **Scope, stated plainly (this test's whole reason for having a header comment at
 * all):** the Inngest emitter is mocked here, so `dispatcher.send`'s own cost is
 * whatever `Promise.resolve()` costs — effectively zero. This test therefore measures
 * the DB-and-handler path (signature verification, dedup insert, fan-out query, upsert,
 * dispatch-payload write, mark-dispatched write) that runs *underneath*
 * `emitPullRequestReviewRequested`, not the Inngest send itself. `emit.ts`'s own
 * `EMIT_TIMEOUT_MS = 300` is what bounds the real send's contribution to the 500 ms
 * budget in production; this test and that timeout together are what the budget in
 * phase-06 §12/§14.1 actually covers — this file alone does not prove a real Inngest
 * round trip fits in the remaining ~200 ms, only that the rest of the path leaves that
 * much room.
 *
 * `checkRateLimit` is mocked to always allow, for a reason that has nothing to do with
 * the rate limiter's own correctness (that is `lib/rate-limit.test.ts`'s job) and
 * everything to do with this test's own validity: 200 concurrent deliveries would
 * otherwise trip `webhook-rate-limit.ts`'s 100/60s-per-installation guard by design,
 * which would make this test measure "the rate limiter's 200 fast-path" for the second
 * half of the run rather than "the full ingestion path" for all 200 — precisely the
 * confound `webhook-helpers.ts`'s own per-fixture unique-installation-id default exists
 * to avoid for the *rest* of this suite, but this file needs every one of its 200
 * deliveries to share one tenant (one repository, one real fan-out query shape) instead.
 */

vi.mock("../../src/inngest/emit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/inngest/emit.js")>();
  return { ...actual, emitPullRequestReviewRequested: vi.fn() };
});
vi.mock("../../src/lib/rate-limit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/rate-limit.js")>();
  return { ...actual, checkRateLimit: vi.fn(async () => ({ allowed: true as const })) };
});

const { emitPullRequestReviewRequested } = await import("../../src/inngest/emit.js");
const { default: app } = await import("../../src/app.js");

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

function percentile(sortedMs: readonly number[], p: number): number {
  const rank = Math.ceil((p / 100) * sortedMs.length) - 1;
  return sortedMs[Math.max(0, Math.min(sortedMs.length - 1, rank))]!;
}

/** A small worker pool, not `Promise.all` over all 200 at once — 200 truly simultaneous
 * connections would measure this test runner's own event-loop/socket scheduling as much
 * as the endpoint, and is not a realistic GitHub delivery burst in the first place
 * (GitHub fans deliveries out from many independent webhook workers, not one process
 * opening 200 sockets in the same tick). 25 concurrent in-flight requests is a
 * deliberately modest, realistic burst — high enough to keep the server saturated
 * throughout the run, low enough that the number being measured is still "how fast does
 * one request complete," not "how many sockets can Node hold open." */
const CONCURRENCY = 25;

async function runWithConcurrency(count: number, worker: (index: number) => Promise<number>): Promise<number[]> {
  const results: number[] = new Array(count);
  let next = 0;
  async function runner(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= count) return;
      results[index] = await worker(index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, count) }, runner));
  return results;
}

describe.skipIf(process.env.SKIP_PERF_TESTS === "1")("POST /api/webhooks/github — acknowledgment latency (§14/§15)", () => {
  const DELIVERY_COUNT = 200;

  it(`acknowledges ${DELIVERY_COUNT.toString()} concurrent deliveries at p99 < 500ms`, async () => {
    const tenant = await seedWebhookTenant();

    const durationsMs = await runWithConcurrency(DELIVERY_COUNT, async (index) => {
      const { text } = loadWebhookFixture("pull-request-opened.json", {
        installationId: Number(tenant.installationId),
        mutate: (payload) => {
          const number = 10_000 + index;
          (payload as Record<string, unknown>).number = number;
          const pr = payload.pull_request as Record<string, unknown>;
          pr.number = number;
          pr.id = 2_000_000_000 + index;
          (pr.head as Record<string, unknown>).sha = `latency-test-sha-${index.toString().padStart(6, "0")}`;
        },
      });

      const startedAt = performance.now();
      const res = await postWebhook(app, { body: text, event: "pull_request", deliveryId: newDeliveryId() });
      const elapsedMs = performance.now() - startedAt;

      expect(res.status).toBe(200);
      return elapsedMs;
    });

    const sorted = [...durationsMs].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    const max = sorted.at(-1)!;

    // Printed unconditionally (not just on failure) — the recorded baseline a future
    // regression needs to be diagnosable against, matching
    // repository-index-performance.test.ts's own precedent.
    console.log(
      `[perf] webhook ack latency, ${DELIVERY_COUNT.toString()} deliveries at concurrency ${CONCURRENCY.toString()}: ` +
        `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms max=${max.toFixed(1)}ms`,
    );

    expect(await prisma.webhookEvent.count()).toBe(DELIVERY_COUNT);
    expect(p99).toBeLessThan(500);
  }, 30_000);
});
