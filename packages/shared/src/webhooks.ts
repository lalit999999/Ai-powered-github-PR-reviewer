/**
 * Type-level vocabulary for Phase 06's webhook-ingestion tables and settings (phase-06
 * §6/§4). Follows `indexing.ts`'s exact discipline: a plain `String`/`Json` database
 * column's legal values are pinned here as an `as const` array plus a derived union,
 * rather than enforced with a Postgres enum or trusted to be well-formed at read time —
 * see that file's own header comment for the fuller argument (docs/decisions/
 * phase-03-log.md, sub-task 1.3) and `Repository.connectionStatus`'s original precedent
 * (docs/decisions/phase-02-log.md §5).
 *
 * This lives in `@repo/shared`, not an app-local types module, for the same
 * cross-deployable reason `indexing.ts` does: `apps/api`'s webhook router writes
 * `WebhookEvent.status` and reads `Project.settings`, while `apps/worker`'s Phase 07
 * debounce logic reads the identical `ProjectReviewSettings` shape off the same column.
 * A contract two deployables must agree on belongs here, not duplicated on both sides.
 */

// ---------------------------------------------------------------------------
// WebhookEvent.status
// ---------------------------------------------------------------------------

/** phase-06 §6. `PENDING` (row inserted, dispatch not yet attempted or in flight) →
 * `DISPATCHED` (the Inngest send succeeded) or `FAILED` (it did not — the sweeper's
 * retry target, Prompt 4) or `IGNORED` (allow-listed event, but this delivery's own
 * action does not trigger a dispatch — e.g. `pull_request.edited`). */
export const WEBHOOK_EVENT_STATUSES = ["PENDING", "DISPATCHED", "IGNORED", "FAILED"] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

// ---------------------------------------------------------------------------
// PullRequest.state
// ---------------------------------------------------------------------------

/**
 * Deliberately GitHub's own lowercase spelling (`open`/`closed`), not this codebase's
 * usual SCREAMING_SNAKE_CASE convention (`WEBHOOK_EVENT_STATUSES` above,
 * `INDEX_JOB_STATUSES` in `indexing.ts`) — because the value is copied verbatim out of
 * the webhook payload's `pull_request.state` and written unchanged. Re-casing it at the
 * boundary would create a second spelling of the same fact to keep in sync against every
 * future GitHub payload this system reads; copying GitHub's own spelling means there is
 * only ever one. This is an inconsistency with the rest of the file's naming, chosen
 * deliberately rather than missed.
 */
export const PULL_REQUEST_STATES = ["open", "closed"] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

// ---------------------------------------------------------------------------
// Project.settings — the review-trigger subset
// ---------------------------------------------------------------------------

/**
 * phase-06 §4 / plan.md §14.2: "make it a project setting" whether draft pull requests
 * are reviewed on `opened`/`reopened`/`synchronize`, or skipped until they leave draft
 * (`ready_for_review`). Defaults to skipping drafts — the common case is a draft PR is
 * still being written, and reviewing every push to it would be noisy and wasteful of
 * whatever an LLM review costs.
 *
 * Only this one setting is modeled today. `Project.settings` is a single `Json` column
 * shared by every phase that wants project-level configuration (phase-01 §6); this type
 * is deliberately narrow to what Phase 06 actually reads, not a speculative "all settings
 * this project could ever have" shape.
 */
export interface ProjectReviewSettings {
  reviewDraftPullRequests: boolean;
}

export const DEFAULT_PROJECT_REVIEW_SETTINGS: ProjectReviewSettings = {
  reviewDraftPullRequests: false,
};

/**
 * Parses the raw `Project.settings` JSON column value into a fully-populated
 * `ProjectReviewSettings`, falling back to the default for anything missing or
 * structurally wrong. `settings` is typed `unknown`, not `Record<string, unknown>`,
 * because Prisma's `Json` column type is a union that also includes arrays, strings,
 * numbers, booleans, and `null` — a hand-edited or not-yet-migrated row can hold any of
 * them, and this function has to survive all of them.
 *
 * **Must never throw.** A malformed `settings` value is not this webhook delivery's
 * fault, and a hand-edited settings row must not be able to turn a routine
 * `pull_request.opened` delivery into an unhandled exception in the request path — the
 * one thing phase-06 §0 exists to prevent above everything else. Every branch below
 * returns a value; none of them re-throws or rethrows a parse error.
 */
export function parseProjectReviewSettings(settings: unknown): ProjectReviewSettings {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return { ...DEFAULT_PROJECT_REVIEW_SETTINGS };
  }

  const raw = (settings as Record<string, unknown>).reviewDraftPullRequests;
  return {
    reviewDraftPullRequests: typeof raw === "boolean" ? raw : DEFAULT_PROJECT_REVIEW_SETTINGS.reviewDraftPullRequests,
  };
}
