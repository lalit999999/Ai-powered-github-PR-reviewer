import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
// Replaces the client entirely, so this test never constructs an Inngest instance and
// never touches the config module or the network.
vi.mock("./client.js", () => ({ inngest: { send } }));

const logSpies = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock("../lib/logger.js", () => ({ createLogger: () => logSpies }));

const { emitProjectDeleted } = await import("./emit.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("emitProjectDeleted (phase-01 §8)", () => {
  it("sends the event under the name from the shared contract", async () => {
    send.mockResolvedValueOnce(undefined);

    await emitProjectDeleted({ projectId: "project-1" });

    expect(send).toHaveBeenCalledWith({ name: "project/deleted", data: { projectId: "project-1" } });
  });

  it("does not fail the caller when Inngest is unreachable — it logs instead", async () => {
    // The soft-delete row update has already committed by the time this runs, and the
    // event has no consumer in this phase. Rejecting an already-successful delete
    // because a fire-and-forget notification failed would be strictly worse; the
    // failure has to be *visible*, not fatal. See emit.ts for the full reasoning.
    send.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:8288"));

    await expect(emitProjectDeleted({ projectId: "project-1" })).resolves.toBeUndefined();

    expect(logSpies.error).toHaveBeenCalledWith(
      "failed to emit project/deleted",
      expect.objectContaining({ event: "project/deleted", projectId: "project-1" })
    );
  });
});
