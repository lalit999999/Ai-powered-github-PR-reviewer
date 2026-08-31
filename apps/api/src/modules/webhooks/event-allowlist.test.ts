import { describe, expect, it } from "vitest";
import {
  isAllowedEvent,
  isReviewTriggeringAction,
  REVIEW_TRIGGERING_ACTIONS,
} from "./event-allowlist.js";

describe("isAllowedEvent", () => {
  it.each([
    "pull_request",
    "installation",
    "installation_repositories",
    "repository",
    "push",
    "ping",
  ])("allows %s", (eventType) => {
    expect(isAllowedEvent(eventType)).toBe(true);
  });

  it.each(["issue_comment", "pull_request_review_comment", "check_run"])(
    "rejects the plausible-but-not-listed event %s",
    (eventType) => {
      expect(isAllowedEvent(eventType)).toBe(false);
    },
  );

  it("rejects outright garbage", () => {
    expect(isAllowedEvent("")).toBe(false);
    expect(isAllowedEvent("totally-not-a-github-event")).toBe(false);
  });
});

describe("isReviewTriggeringAction", () => {
  it.each(REVIEW_TRIGGERING_ACTIONS)(
    "narrows %s as review-triggering",
    (action) => {
      expect(isReviewTriggeringAction(action)).toBe(true);
    },
  );

  it.each(["edited", "closed", "converted_to_draft"])(
    "does not narrow %s as review-triggering",
    (action) => {
      expect(isReviewTriggeringAction(action)).toBe(false);
    },
  );

  it("does not narrow an undefined action", () => {
    expect(isReviewTriggeringAction(undefined)).toBe(false);
  });
});
