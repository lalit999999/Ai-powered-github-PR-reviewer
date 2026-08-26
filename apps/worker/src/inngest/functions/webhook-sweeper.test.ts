import { describe, expect, it, vi } from "vitest";

// buildSweepSends (the only thing under test here) never calls into the repository
// layer — it takes already-fetched rows — but importing webhook-sweeper.ts still
// statically imports webhook-event.repository.ts, which imports @repo/db's `prisma`
// singleton at module-load time, which requires DATABASE_URL to be set. Mocked here for
// the identical reason stale-index-sweeper.test.ts mocks its own repository module —
// see that file's own comment.
vi.mock("../../webhooks/webhook-event.repository.js", () => ({
  findPendingOlderThan: vi.fn(),
  markDispatched: vi.fn(),
  markFailed: vi.fn(),
}));

const { buildSweepSends } = await import("./webhook-sweeper.js");

const SAMPLE_EVENT_DATA = {
  projectId: "proj-1",
  repositoryId: "repo-1",
  installationId: "123",
  pullRequestNumber: 7,
  headSha: "abc123",
  baseSha: "def456",
  trigger: "opened" as const,
  traceId: "trace-1",
  prKey: "repo-1:7:abc123",
};

function pendingRow(overrides: { id?: string; deliveryId?: string; dispatchPayload?: unknown } = {}) {
  return {
    id: "event-1",
    deliveryId: "delivery-1",
    eventType: "pull_request",
    action: "opened",
    dispatchPayload: [SAMPLE_EVENT_DATA],
    ...overrides,
  };
}

describe("buildSweepSends", () => {
  it("returns no sends and no skips for an empty result", () => {
    expect(buildSweepSends([])).toEqual({ sends: [], skips: [] });
  });

  it("produces one send per valid pending row, and no skips", () => {
    const rows = [
      pendingRow({ id: "event-1", deliveryId: "delivery-1" }),
      pendingRow({ id: "event-2", deliveryId: "delivery-2" }),
      pendingRow({ id: "event-3", deliveryId: "delivery-3" }),
    ];

    const plan = buildSweepSends(rows);

    expect(plan.sends).toHaveLength(3);
    expect(plan.skips).toHaveLength(0);
    expect(plan.sends.map((send) => send.rowId)).toEqual(["event-1", "event-2", "event-3"]);
  });

  it("produces the exact event name and payload shape from @repo/shared, keyed by prKey", () => {
    const row = pendingRow();
    const plan = buildSweepSends([row]);

    expect(plan.sends).toHaveLength(1);
    const [event] = plan.sends[0]!.events;
    expect(event!.name).toBe("pull-request/review.requested");
    expect(event!.data).toEqual(SAMPLE_EVENT_DATA);
    expect(event!.id).toBe("repo-1:7:abc123");
  });

  it("a row with dispatchPayload: null becomes a skip, not a send", () => {
    const rows = [pendingRow({ id: "event-null", dispatchPayload: null })];

    const plan = buildSweepSends(rows);

    expect(plan.sends).toHaveLength(0);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0]).toMatchObject({ rowId: "event-null", code: "UNSWEEPABLE_DISPATCH_PAYLOAD" });
  });

  it("a row with a malformed (non-array) dispatchPayload also becomes a skip", () => {
    const rows = [pendingRow({ id: "event-bad", dispatchPayload: { not: "an array" } })];

    const plan = buildSweepSends(rows);

    expect(plan.sends).toHaveLength(0);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0]?.rowId).toBe("event-bad");
  });

  it("splits a mixed batch correctly", () => {
    const rows = [pendingRow({ id: "event-ok" }), pendingRow({ id: "event-null", dispatchPayload: null })];

    const plan = buildSweepSends(rows);

    expect(plan.sends.map((send) => send.rowId)).toEqual(["event-ok"]);
    expect(plan.skips.map((skip) => skip.rowId)).toEqual(["event-null"]);
  });
});
