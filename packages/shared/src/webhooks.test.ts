import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_REVIEW_SETTINGS,
  parseProjectReviewSettings,
} from "./webhooks.js";

describe("parseProjectReviewSettings", () => {
  it("falls back to the default for an empty object", () => {
    expect(parseProjectReviewSettings({})).toEqual(
      DEFAULT_PROJECT_REVIEW_SETTINGS,
    );
  });

  it("falls back to the default for null", () => {
    expect(parseProjectReviewSettings(null)).toEqual(
      DEFAULT_PROJECT_REVIEW_SETTINGS,
    );
  });

  it("falls back to the default for undefined", () => {
    expect(parseProjectReviewSettings(undefined)).toEqual(
      DEFAULT_PROJECT_REVIEW_SETTINGS,
    );
  });

  it("falls back to the default for an array", () => {
    expect(parseProjectReviewSettings([1, 2, 3])).toEqual(
      DEFAULT_PROJECT_REVIEW_SETTINGS,
    );
  });

  it("falls back to the default for a string", () => {
    expect(parseProjectReviewSettings("not-an-object")).toEqual(
      DEFAULT_PROJECT_REVIEW_SETTINGS,
    );
  });

  it("respects an explicit reviewDraftPullRequests: true", () => {
    expect(
      parseProjectReviewSettings({ reviewDraftPullRequests: true }),
    ).toEqual({
      reviewDraftPullRequests: true,
    });
  });

  it("falls back to the default when reviewDraftPullRequests has the wrong type", () => {
    expect(
      parseProjectReviewSettings({ reviewDraftPullRequests: "yes" }),
    ).toEqual(DEFAULT_PROJECT_REVIEW_SETTINGS);
  });

  it("ignores unrelated extra keys", () => {
    expect(
      parseProjectReviewSettings({
        reviewDraftPullRequests: true,
        somethingElse: 42,
        nested: { a: 1 },
      }),
    ).toEqual({ reviewDraftPullRequests: true });
  });

  it("never throws, even for deeply malformed input", () => {
    expect(() => parseProjectReviewSettings(() => undefined)).not.toThrow();
    expect(() => parseProjectReviewSettings(Symbol("x"))).not.toThrow();
  });
});
