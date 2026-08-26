import { describe, expect, it, vi } from "vitest";

// buildSweepEvents (the only thing under test here) never calls into the repository
// layer itself — it takes already-fetched rows — but importing stale-index-sweeper.ts
// still statically imports repository.repository.ts, which imports @repo/db's `prisma`
// singleton at module-load time. That singleton requires DATABASE_URL to be set in
// process.env, which normally happens as a side effect of config/env.ts's own
// `import "dotenv/config"` — a side effect this module has no reason to pull in itself
// (it never reads env directly). Mocked here rather than relying on some other import
// in the graph to have loaded dotenv first, which is exactly the kind of implicit,
// load-order-dependent behavior that breaks the moment a neighboring import changes.
vi.mock("../../indexing/persistence/repository.repository.js", () => ({ findStalePending: vi.fn() }));

const { buildSweepEvents } = await import("./stale-index-sweeper.js");

describe("buildSweepEvents", () => {
  it("builds one repository/index.requested event per stale repository, reason: sweep", () => {
    const events = buildSweepEvents([
      { id: "repo-1", projectId: "proj-1" },
      { id: "repo-2", projectId: "proj-2" },
    ]);

    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.name).toBe("repository/index.requested");
      expect(event.data.mode).toBe("FULL");
      expect(event.data.reason).toBe("sweep");
    }
    expect(events[0]?.data).toMatchObject({ repositoryId: "repo-1", projectId: "proj-1" });
    expect(events[1]?.data).toMatchObject({ repositoryId: "repo-2", projectId: "proj-2" });
  });

  it("gives each event its own freshly-generated indexJobId", () => {
    const events = buildSweepEvents([
      { id: "repo-1", projectId: "proj-1" },
      { id: "repo-2", projectId: "proj-2" },
    ]);

    expect(events[0]?.data.indexJobId).toEqual(expect.any(String));
    expect(events[1]?.data.indexJobId).toEqual(expect.any(String));
    expect(events[0]?.data.indexJobId).not.toBe(events[1]?.data.indexJobId);
  });

  it("returns an empty array for no stale repositories", () => {
    expect(buildSweepEvents([])).toEqual([]);
  });
});
