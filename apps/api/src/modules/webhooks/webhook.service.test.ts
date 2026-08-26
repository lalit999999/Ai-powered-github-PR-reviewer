import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestReviewRequestedData } from "@repo/shared";
import type { WebhookTenantTarget } from "../repositories/repository.repository.js";

/**
 * The seams: the two webhook-local repository files and the repository-repository
 * module's fan-out (all three own their own Prisma import). `event-router.ts` and
 * `webhook.schema.ts` are **not** mocked — both are pure/schema modules, and running
 * the real router is what makes these tests prove the service's own ordering rather
 * than a stub standing in for it. Same discipline `repository.service.test.ts` uses for
 * `repository-validation.service.ts`.
 */
vi.mock("./webhook-event.repository.js", () => ({
  insertPending: vi.fn(),
  markDispatched: vi.fn(),
  markIgnored: vi.fn(),
  markFailed: vi.fn(),
  savePendingDispatchPayload: vi.fn(),
}));
vi.mock("./pull-request.repository.js", () => ({ upsertMinimal: vi.fn() }));
vi.mock("../repositories/repository.repository.js", () => ({ findConnectedByGithubRepoId: vi.fn() }));

const logSpies = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock("@repo/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/observability")>();
  return { ...actual, createLogger: () => logSpies };
});

const webhookEventRepository = await import("./webhook-event.repository.js");
const pullRequestRepository = await import("./pull-request.repository.js");
const repositoryRepository = await import("../repositories/repository.repository.js");
const { InternalError } = await import("../../lib/errors.js");
const { ingestDelivery } = await import("./webhook.service.js");

const mockedInsertPending = vi.mocked(webhookEventRepository.insertPending);
const mockedMarkDispatched = vi.mocked(webhookEventRepository.markDispatched);
const mockedMarkIgnored = vi.mocked(webhookEventRepository.markIgnored);
const mockedMarkFailed = vi.mocked(webhookEventRepository.markFailed);
const mockedSavePendingDispatchPayload = vi.mocked(webhookEventRepository.savePendingDispatchPayload);
const mockedUpsertMinimal = vi.mocked(pullRequestRepository.upsertMinimal);
const mockedFindConnected = vi.mocked(repositoryRepository.findConnectedByGithubRepoId);

const TENANT: WebhookTenantTarget = {
  repositoryId: "repo-1",
  projectId: "project-1",
  installationId: 999n,
  fullName: "octocat/hello-world",
  projectSettings: {},
  projectDeletedAt: null,
};

function rawPullRequestPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    number: 42,
    pull_request: {
      id: 555,
      number: 42,
      state: "open",
      draft: false,
      head: { sha: "headsha1" },
      base: { sha: "basesha1" },
    },
    repository: {
      id: 1296269,
      full_name: "octocat/hello-world",
      name: "hello-world",
      owner: { login: "octocat" },
      html_url: "https://github.com/octocat/hello-world",
    },
    installation: { id: 999 },
    ...overrides,
  };
}

function stubDispatcher(impl?: (events: readonly PullRequestReviewRequestedData[]) => Promise<void>) {
  return { send: vi.fn(impl ?? (() => Promise.resolve())) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedInsertPending.mockResolvedValue({ ok: true, id: "event-1" });
  mockedFindConnected.mockResolvedValue([TENANT]);
  mockedUpsertMinimal.mockResolvedValue({ id: "pr-1" });
});

describe("ingestDelivery", () => {
  it("happy path: dispatches and marks the row DISPATCHED", async () => {
    const dispatcher = stubDispatcher();

    const outcome = await ingestDelivery({
      deliveryId: "delivery-1",
      eventType: "pull_request",
      rawPayload: rawPullRequestPayload(),
      traceId: "trace-1",
      dispatcher,
    });

    expect(outcome).toEqual({ status: "DISPATCHED", eventCount: 1 });
    expect(dispatcher.send).toHaveBeenCalledTimes(1);
    expect(dispatcher.send.mock.calls[0]?.[0]).toHaveLength(1);
    expect(mockedSavePendingDispatchPayload).toHaveBeenCalledWith("event-1", expect.any(Array));
    expect(mockedMarkDispatched).toHaveBeenCalledWith("event-1", expect.any(Array));
    expect(mockedUpsertMinimal).toHaveBeenCalledTimes(1);
  });

  it("duplicate delivery: returns DUPLICATE and never calls the fan-out query", async () => {
    mockedInsertPending.mockResolvedValue({ ok: false, reason: "DUPLICATE_DELIVERY" });
    const dispatcher = stubDispatcher();

    const outcome = await ingestDelivery({
      deliveryId: "delivery-1",
      eventType: "pull_request",
      rawPayload: rawPullRequestPayload(),
      traceId: "trace-1",
      dispatcher,
    });

    expect(outcome).toEqual({ status: "DUPLICATE" });
    expect(mockedFindConnected).not.toHaveBeenCalled();
    expect(mockedUpsertMinimal).not.toHaveBeenCalled();
    expect(dispatcher.send).not.toHaveBeenCalled();
  });

  it("dispatcher throws: returns PENDING, never marks DISPATCHED or FAILED", async () => {
    const dispatcher = stubDispatcher(() => Promise.reject(new Error("inngest unavailable")));

    const outcome = await ingestDelivery({
      deliveryId: "delivery-1",
      eventType: "pull_request",
      rawPayload: rawPullRequestPayload(),
      traceId: "trace-1",
      dispatcher,
    });

    expect(outcome).toEqual({ status: "PENDING", reason: "DISPATCH_FAILED" });
    expect(mockedMarkDispatched).not.toHaveBeenCalled();
    expect(mockedMarkFailed).not.toHaveBeenCalled();
  });

  it("router says ignore: returns IGNORED, dispatcher never called, upserts still applied", async () => {
    const dispatcher = stubDispatcher();

    const outcome = await ingestDelivery({
      deliveryId: "delivery-1",
      eventType: "pull_request",
      rawPayload: rawPullRequestPayload({ action: "edited" }),
      traceId: "trace-1",
      dispatcher,
    });

    expect(outcome).toEqual({ status: "IGNORED", reason: "EDITED_METADATA_ONLY" });
    expect(dispatcher.send).not.toHaveBeenCalled();
    expect(mockedUpsertMinimal).toHaveBeenCalledTimes(1);
    expect(mockedMarkIgnored).toHaveBeenCalledWith("event-1", "EDITED_METADATA_ONLY");
  });

  it("malformed payload: returns FAILED, and a row is still inserted for audit", async () => {
    const dispatcher = stubDispatcher();

    const outcome = await ingestDelivery({
      deliveryId: "delivery-1",
      eventType: "pull_request",
      rawPayload: { action: "opened" }, // missing pull_request/repository/installation
      traceId: "trace-1",
      dispatcher,
    });

    expect(outcome).toEqual({ status: "FAILED", code: "MALFORMED_PAYLOAD" });
    expect(mockedInsertPending).toHaveBeenCalledTimes(1);
    expect(mockedMarkFailed).toHaveBeenCalledWith("event-1", expect.objectContaining({ code: "MALFORMED_PAYLOAD" }));
    expect(mockedFindConnected).not.toHaveBeenCalled();
    expect(dispatcher.send).not.toHaveBeenCalled();
  });

  it("no connected repository: returns IGNORED / NO_CONNECTED_REPOSITORY with no upserts", async () => {
    mockedFindConnected.mockResolvedValue([]);
    const dispatcher = stubDispatcher();

    const outcome = await ingestDelivery({
      deliveryId: "delivery-1",
      eventType: "pull_request",
      rawPayload: rawPullRequestPayload(),
      traceId: "trace-1",
      dispatcher,
    });

    expect(outcome).toEqual({ status: "IGNORED", reason: "NO_CONNECTED_REPOSITORY" });
    expect(mockedUpsertMinimal).not.toHaveBeenCalled();
  });

  it("ping: inserts and immediately marks IGNORED / PING, no fan-out", async () => {
    const dispatcher = stubDispatcher();

    const outcome = await ingestDelivery({
      deliveryId: "delivery-2",
      eventType: "ping",
      rawPayload: { zen: "Speak like a human." },
      traceId: "trace-1",
      dispatcher,
    });

    expect(outcome).toEqual({ status: "IGNORED", reason: "PING" });
    expect(mockedFindConnected).not.toHaveBeenCalled();
    expect(mockedMarkIgnored).toHaveBeenCalledWith("event-1", "PING");
  });

  it("push: inserts and immediately marks IGNORED / PUSH_NOT_HANDLED_IN_MVP", async () => {
    const dispatcher = stubDispatcher();

    const outcome = await ingestDelivery({
      deliveryId: "delivery-3",
      eventType: "push",
      rawPayload: {},
      traceId: "trace-1",
      dispatcher,
    });

    expect(outcome).toEqual({ status: "IGNORED", reason: "PUSH_NOT_HANDLED_IN_MVP" });
    expect(mockedMarkIgnored).toHaveBeenCalledWith("event-1", "PUSH_NOT_HANDLED_IN_MVP");
  });

  it("an unhandled event type is a programming error, not a client condition", async () => {
    const dispatcher = stubDispatcher();

    await expect(
      ingestDelivery({
        deliveryId: "delivery-4",
        eventType: "installation",
        rawPayload: {},
        traceId: "trace-1",
        dispatcher,
      }),
    ).rejects.toThrow(InternalError);
  });
});
