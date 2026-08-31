import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
// Replaces the client entirely, so this test never constructs an Inngest instance and
// never touches the config module or the network.
vi.mock("./client.js", () => ({ inngest: { send } }));

const logSpies = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
vi.mock("@repo/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/observability")>();
  return { ...actual, createLogger: () => logSpies };
});

const {
  emitProjectDeleted,
  emitRepositoryIndexRequested,
  emitPullRequestReviewRequested,
} = await import("./emit.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("emitProjectDeleted (phase-01 §8)", () => {
  it("sends the event under the name from the shared contract", async () => {
    send.mockResolvedValueOnce(undefined);

    await emitProjectDeleted({ projectId: "project-1" });

    expect(send).toHaveBeenCalledWith({
      name: "project/deleted",
      data: { projectId: "project-1" },
    });
  });

  it("does not fail the caller when Inngest is unreachable — it logs instead", async () => {
    // The soft-delete row update has already committed by the time this runs, and the
    // event has no consumer in this phase. Rejecting an already-successful delete
    // because a fire-and-forget notification failed would be strictly worse; the
    // failure has to be *visible*, not fatal. See emit.ts for the full reasoning.
    send.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 127.0.0.1:8288"),
    );

    await expect(
      emitProjectDeleted({ projectId: "project-1" }),
    ).resolves.toBeUndefined();

    expect(logSpies.error).toHaveBeenCalledWith(
      "failed to emit project/deleted",
      expect.objectContaining({
        event: "project/deleted",
        projectId: "project-1",
      }),
    );
  });
});

describe("emitRepositoryIndexRequested (phase-02 §8)", () => {
  const payload = {
    projectId: "project-1",
    repositoryId: "repo-1",
    mode: "FULL",
    reason: "connected",
  } as const;

  it("sends the event under the name from the shared contract, with the §8 payload", async () => {
    send.mockResolvedValueOnce(undefined);

    await emitRepositoryIndexRequested(payload);

    expect(send).toHaveBeenCalledWith({
      name: "repository/index.requested",
      data: payload,
    });
  });

  it("logs at error with BOTH ids when Inngest is unreachable, and still resolves", async () => {
    // This event is the only indexing trigger from Phase 03 onward, so a dropped one
    // has to be *visible* — hence `error`, not `warn`. It is still not fatal: the
    // Repository row is already committed in PENDING, which is the durable record and
    // the thing Phase 03 reconciles from. See emit.ts for the full argument.
    send.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 127.0.0.1:8288"),
    );

    await expect(
      emitRepositoryIndexRequested(payload),
    ).resolves.toBeUndefined();

    expect(logSpies.error).toHaveBeenCalledWith(
      "failed to emit repository/index.requested",
      expect.objectContaining({
        event: "repository/index.requested",
        projectId: "project-1",
        repositoryId: "repo-1",
      }),
    );
  });
});

describe("emitPullRequestReviewRequested (phase-06 §8)", () => {
  const event = {
    projectId: "project-1",
    repositoryId: "repo-1",
    installationId: "999",
    pullRequestNumber: 42,
    headSha: "headsha1",
    baseSha: "basesha1",
    trigger: "opened",
    traceId: "trace-1",
    prKey: "repo-1:42:headsha1",
  } as const;

  it("sends the event with its prKey as the Inngest id, and resolves { ok: true }", async () => {
    send.mockResolvedValueOnce(undefined);

    const result = await emitPullRequestReviewRequested([event]);

    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith([
      { name: "pull-request/review.requested", data: event, id: event.prKey },
    ]);
  });

  it("returns { ok: false } and does not throw when send() rejects", async () => {
    send.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 127.0.0.1:8288"),
    );

    const result = await emitPullRequestReviewRequested([event]);

    expect(result).toEqual({
      ok: false,
      error: "connect ECONNREFUSED 127.0.0.1:8288",
    });
    expect(logSpies.error).toHaveBeenCalledWith(
      "failed to emit pull-request/review.requested",
      expect.objectContaining({
        event: "pull-request/review.requested",
        prKeys: [event.prKey],
      }),
    );
  });

  it("returns { ok: false } within roughly the timeout when send() hangs", async () => {
    vi.useFakeTimers();
    try {
      // Never resolves — simulates a hung connection to Inngest.
      send.mockImplementationOnce(() => new Promise(() => {}));

      const resultPromise = emitPullRequestReviewRequested([event]);
      await vi.advanceTimersByTimeAsync(300);
      const result = await resultPromise;

      expect(result).toEqual({
        ok: false,
        error: "emit timed out after 300ms",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
