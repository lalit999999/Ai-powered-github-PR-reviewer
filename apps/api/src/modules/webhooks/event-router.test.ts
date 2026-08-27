import { describe, expect, it } from "vitest";
import { routePullRequestEvent } from "./event-router.js";
import type { ParsedPullRequestEvent } from "./webhook.schema.js";
import type { WebhookTenantTarget } from "../repositories/repository.repository.js";

const TRACE_ID = "trace-abc";

function tenant(overrides: Partial<WebhookTenantTarget> = {}): WebhookTenantTarget {
  return {
    repositoryId: "repo-1",
    projectId: "project-1",
    installationId: 999n,
    fullName: "octocat/hello-world",
    projectSettings: {},
    projectDeletedAt: null,
    ...overrides,
  };
}

function payload(overrides: Partial<ParsedPullRequestEvent> = {}): ParsedPullRequestEvent {
  return {
    action: "opened",
    number: 42,
    pull_request: {
      id: 555n,
      number: 42,
      state: "open",
      draft: false,
      head: { sha: "headsha1" },
      base: { sha: "basesha1" },
    },
    repository: {
      id: 1296269n,
      full_name: "octocat/hello-world",
      name: "hello-world",
      owner: { login: "octocat" },
      html_url: "https://github.com/octocat/hello-world",
    },
    installation: { id: 999n },
    ...overrides,
  } as ParsedPullRequestEvent;
}

describe("routePullRequestEvent", () => {
  it("dispatches on each triggering action", () => {
    for (const action of ["opened", "reopened", "synchronize", "ready_for_review"] as const) {
      const decision = routePullRequestEvent({ payload: payload({ action }), tenants: [tenant()], traceId: TRACE_ID });
      expect(decision.kind).toBe("DISPATCH");
    }
  });

  it("edited -> PERSIST_ONLY / EDITED_METADATA_ONLY", () => {
    const decision = routePullRequestEvent({ payload: payload({ action: "edited" }), tenants: [tenant()], traceId: TRACE_ID });
    expect(decision).toMatchObject({ kind: "PERSIST_ONLY", reason: "EDITED_METADATA_ONLY" });
    if (decision.kind === "PERSIST_ONLY") {
      expect(decision.pullRequestUpserts).toHaveLength(1);
    }
  });

  it("closed -> PERSIST_ONLY", () => {
    const decision = routePullRequestEvent({ payload: payload({ action: "closed" }), tenants: [tenant()], traceId: TRACE_ID });
    expect(decision.kind).toBe("PERSIST_ONLY");
  });

  it("converted_to_draft -> PERSIST_ONLY", () => {
    const decision = routePullRequestEvent({
      payload: payload({ action: "converted_to_draft" }),
      tenants: [tenant()],
      traceId: TRACE_ID,
    });
    expect(decision.kind).toBe("PERSIST_ONLY");
  });

  it("draft PR + default settings -> PERSIST_ONLY / DRAFT_SKIPPED", () => {
    const decision = routePullRequestEvent({
      payload: payload({ action: "opened", pull_request: { ...payload().pull_request, draft: true } }),
      tenants: [tenant({ projectSettings: {} })],
      traceId: TRACE_ID,
    });
    expect(decision).toMatchObject({ kind: "PERSIST_ONLY", reason: "DRAFT_SKIPPED" });
    if (decision.kind === "PERSIST_ONLY") {
      expect(decision.pullRequestUpserts).toHaveLength(1);
    }
  });

  it("draft PR + reviewDraftPullRequests:true -> DISPATCH", () => {
    const decision = routePullRequestEvent({
      payload: payload({ action: "opened", pull_request: { ...payload().pull_request, draft: true } }),
      tenants: [tenant({ projectSettings: { reviewDraftPullRequests: true } })],
      traceId: TRACE_ID,
    });
    expect(decision.kind).toBe("DISPATCH");
    if (decision.kind === "DISPATCH") {
      expect(decision.events).toHaveLength(1);
    }
  });

  it("mixed tenants: one opted in, one not, on a draft PR -> exactly one event, two upserts", () => {
    const draftPayload = payload({ action: "opened", pull_request: { ...payload().pull_request, draft: true } });
    const tenantOptedIn = tenant({
      repositoryId: "repo-a",
      projectId: "project-a",
      projectSettings: { reviewDraftPullRequests: true },
    });
    const tenantOptedOut = tenant({
      repositoryId: "repo-b",
      projectId: "project-b",
      projectSettings: { reviewDraftPullRequests: false },
    });

    const decision = routePullRequestEvent({
      payload: draftPayload,
      tenants: [tenantOptedIn, tenantOptedOut],
      traceId: TRACE_ID,
    });

    expect(decision.kind).toBe("DISPATCH");
    if (decision.kind === "DISPATCH") {
      expect(decision.events).toHaveLength(1);
      expect(decision.events[0]?.projectId).toBe("project-a");
      expect(decision.pullRequestUpserts).toHaveLength(2);
    }
  });

  it("two tenants, non-draft, triggering action -> exactly two events with different prKeys and tenant ids", () => {
    const tenantA = tenant({ repositoryId: "repo-a", projectId: "project-a" });
    const tenantB = tenant({ repositoryId: "repo-b", projectId: "project-b" });

    const decision = routePullRequestEvent({
      payload: payload({ action: "opened" }),
      tenants: [tenantA, tenantB],
      traceId: TRACE_ID,
    });

    expect(decision.kind).toBe("DISPATCH");
    if (decision.kind === "DISPATCH") {
      expect(decision.events).toHaveLength(2);
      const [eventA, eventB] = decision.events;
      expect(eventA?.prKey).not.toBe(eventB?.prKey);
      expect(eventA?.projectId).toBe("project-a");
      expect(eventA?.repositoryId).toBe("repo-a");
      expect(eventB?.projectId).toBe("project-b");
      expect(eventB?.repositoryId).toBe("repo-b");
    }
  });

  it("zero tenants -> IGNORE / NO_CONNECTED_REPOSITORY", () => {
    const decision = routePullRequestEvent({ payload: payload(), tenants: [], traceId: TRACE_ID });
    expect(decision).toEqual({ kind: "IGNORE", reason: "NO_CONNECTED_REPOSITORY" });
  });

  it("ready_for_review dispatches even when the payload still says draft: false", () => {
    const decision = routePullRequestEvent({
      payload: payload({ action: "ready_for_review", pull_request: { ...payload().pull_request, draft: false } }),
      tenants: [tenant({ projectSettings: { reviewDraftPullRequests: false } })],
      traceId: TRACE_ID,
    });
    expect(decision.kind).toBe("DISPATCH");
  });

  it("threads traceId verbatim into every emitted payload", () => {
    const tenantA = tenant({ repositoryId: "repo-a", projectId: "project-a" });
    const tenantB = tenant({ repositoryId: "repo-b", projectId: "project-b" });

    const decision = routePullRequestEvent({
      payload: payload({ action: "opened" }),
      tenants: [tenantA, tenantB],
      traceId: "trace-xyz",
    });

    expect(decision.kind).toBe("DISPATCH");
    if (decision.kind === "DISPATCH") {
      for (const event of decision.events) {
        expect(event.traceId).toBe("trace-xyz");
      }
    }
  });
});
