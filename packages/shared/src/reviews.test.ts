import { describe, expect, it } from "vitest";
import { FILE_CLASSIFICATIONS, type FileClassification } from "./indexing.js";
import {
  buildIdempotencyKey,
  CLASSIFICATION_REVIEW_DEPTH,
  REVIEW_DEPTHS,
  REVIEW_POLICY_VERSION,
  webhookTriggerToReviewTrigger,
} from "./reviews.js";

describe("buildIdempotencyKey", () => {
  it("builds repositoryId:prNumber:headSha:policyVersion without a manual counter", () => {
    expect(
      buildIdempotencyKey({
        repositoryId: "repo-1",
        prNumber: 42,
        headSha: "headsha1",
      }),
    ).toBe(`repo-1:42:headsha1:${REVIEW_POLICY_VERSION}`);
  });

  it("appends :m{n} when a manualRunCounter is supplied", () => {
    expect(
      buildIdempotencyKey({
        repositoryId: "repo-1",
        prNumber: 42,
        headSha: "headsha1",
        manualRunCounter: 2,
      }),
    ).toBe(`repo-1:42:headsha1:${REVIEW_POLICY_VERSION}:m2`);
  });

  it("respects an explicit policyVersion override", () => {
    expect(
      buildIdempotencyKey({
        repositoryId: "repo-1",
        prNumber: 42,
        headSha: "headsha1",
        policyVersion: "2",
      }),
    ).toBe("repo-1:42:headsha1:2");
  });

  it("produces the same key for the same input on both call sites (apps/api and apps/worker share this one function)", () => {
    const input = { repositoryId: "repo-9", prNumber: 7, headSha: "abc123" };
    expect(buildIdempotencyKey(input)).toBe(buildIdempotencyKey({ ...input }));
  });

  it("produces a different key when headSha differs — a new commit is a new review", () => {
    const a = buildIdempotencyKey({
      repositoryId: "repo-1",
      prNumber: 42,
      headSha: "sha-a",
    });
    const b = buildIdempotencyKey({
      repositoryId: "repo-1",
      prNumber: 42,
      headSha: "sha-b",
    });
    expect(a).not.toBe(b);
  });
});

describe("webhookTriggerToReviewTrigger", () => {
  it("maps opened/reopened/ready_for_review to WEBHOOK_OPENED", () => {
    expect(webhookTriggerToReviewTrigger("opened")).toBe("WEBHOOK_OPENED");
    expect(webhookTriggerToReviewTrigger("reopened")).toBe("WEBHOOK_OPENED");
    expect(webhookTriggerToReviewTrigger("ready_for_review")).toBe(
      "WEBHOOK_OPENED",
    );
  });

  it("maps synchronize/sweep to WEBHOOK_SYNC", () => {
    expect(webhookTriggerToReviewTrigger("synchronize")).toBe("WEBHOOK_SYNC");
    expect(webhookTriggerToReviewTrigger("sweep")).toBe("WEBHOOK_SYNC");
  });
});

describe("CLASSIFICATION_REVIEW_DEPTH", () => {
  it("has an entry for every FileClassification except UNKNOWN", () => {
    const mappedKeys = Object.keys(CLASSIFICATION_REVIEW_DEPTH).sort();
    const expectedKeys = FILE_CLASSIFICATIONS.filter(
      (classification): classification is Exclude<FileClassification, "UNKNOWN"> =>
        classification !== "UNKNOWN",
    ).sort();
    expect(mappedKeys).toEqual(expectedKeys);
    expect(mappedKeys).not.toContain("UNKNOWN");
  });

  it("maps every entry to a legal ReviewDepth", () => {
    for (const depth of Object.values(CLASSIFICATION_REVIEW_DEPTH)) {
      expect(REVIEW_DEPTHS).toContain(depth);
    }
  });

  it("matches plan.md §17.1's mapping exactly", () => {
    expect(CLASSIFICATION_REVIEW_DEPTH).toEqual({
      SOURCE: "DEEP",
      TEST: "SHALLOW",
      CONFIG: "SHALLOW",
      GENERATED: "SKIP",
      DEPENDENCY_LOCK: "SKIP",
      DOCUMENTATION: "SHALLOW",
      ASSET: "SKIP",
    });
  });
});
