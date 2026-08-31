/**
 * The webhook event/action allow-list matrix (phase-06-webhook-ingestion.md §16 Definition
 * of Done, plan.md §14.2). This is the **one place** the `X-GitHub-Event` / `action` pairs
 * this system recognizes are written down — every branch Prompt 2's router needs (dispatch
 * a review, sync state without reviewing, sync installation/repository metadata, or do
 * nothing) reads its answer from here, so that adding a new triggering action later (say,
 * `pull_request.assigned`) is a one-line addition to a single array in this file, with
 * nowhere else in the codebase that also needs to know about it.
 *
 * ## The matrix (plan.md §14.2)
 *
 * | `X-GitHub-Event`             | Actions                                            | Handling                          |
 * |-------------------------------|-----------------------------------------------------|------------------------------------|
 * | `pull_request`                 | `opened`, `reopened`, `synchronize`, `ready_for_review` | dispatch a review               |
 * | `pull_request`                 | `closed`, `converted_to_draft`                        | update PR state, no dispatch      |
 * | `pull_request`                 | `edited`                                              | update stored metadata only, never a re-review |
 * | `installation`                 | `created`, `deleted`, `suspend`, `unsuspend`          | installation sync (Prompt 4)      |
 * | `installation_repositories`    | `added`, `removed`                                    | installation sync (Prompt 4)      |
 * | `repository`                   | `renamed`, `deleted`, `archived`, `unarchived`        | repository sync (Prompt 4)        |
 * | `push`                         | — (all actions)                                       | allow-listed only, no handler      |
 * | `ping`                         | — (all actions)                                       | acknowledge, no action              |
 *
 * Anything not in this table is an **unknown event** — see `isAllowedEvent`'s own comment
 * for what happens to one.
 *
 * ## Why `push` is allow-listed with no handler
 *
 * §3 Out of Scope is explicit that emitting a `repository/push.received` event with zero
 * consumers is unnecessary MVP complexity — Phase 14 adds the emission and its consumer
 * together, in the same prompt, so the event contract and its first reader are settled at
 * the same time rather than one waiting on the other for multiple phases. `push` is listed
 * here anyway, today, purely so a repository with an active webhook does not generate
 * "unknown event" noise on every commit pushed to it — GitHub sends a `push` delivery for
 * every push regardless of whether this system does anything with it.
 *
 * ## The unknown-event contradiction, reconciled once
 *
 * §4 Security says an unrecognized `X-GitHub-Event` is "rejected (not silently accepted
 * and ignored — logged as rejected)". §12 says the response code for that case is "400/200
 * per policy — either is acceptable as long as it's consistent and logged; this phase
 * returns 200 to avoid GitHub retry storms." Read together as written, these look like a
 * contradiction: "rejected" reads as "not accepted", and "return 200" reads as "accepted".
 *
 * **Decision:** "rejected" in §4 describes the *side effects* — no `WebhookEvent` row is
 * written, no dispatch is attempted, nothing happens — not the HTTP status code. The
 * response is **200**, exactly as §12 specifies, with a `warn`-level log line carrying a
 * distinct outcome value so the rejection is visible in logs without ever showing up as a
 * row in the audit ledger. A non-2xx response here would only teach GitHub to retry a
 * delivery this server has no intention of ever doing anything different with on retry —
 * the "avoid retry storms" reasoning in §12 applies to unknown events at least as much as
 * to any other case. Recorded here, once, so neither reading of §4 or §12 in isolation
 * causes this to be "corrected" back into a contradiction later.
 */

export const REVIEW_TRIGGERING_ACTIONS = [
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
] as const;
export type ReviewTriggeringAction = (typeof REVIEW_TRIGGERING_ACTIONS)[number];

/** `pull_request.closed`/`converted_to_draft` — the PR's stored state moves, but no
 * review is (re-)triggered. A merged/closed PR does not need reviewing, and a PR pushed
 * back into draft is exactly the state {@link REVIEW_TRIGGERING_ACTIONS} excludes drafts
 * for in the first place. */
export const PULL_REQUEST_STATE_SYNC_ACTIONS = [
  "closed",
  "converted_to_draft",
] as const;
export type PullRequestStateSyncAction =
  (typeof PULL_REQUEST_STATE_SYNC_ACTIONS)[number];

/** `pull_request.edited` — title/body/base branch changed. Stored metadata is updated so
 * it stays current, but this is deliberately **never** a re-review trigger: an edit to
 * the PR description is not a code change, and re-reviewing on every edit would burn
 * review budget on events that never touched a line of code. */
export const PULL_REQUEST_METADATA_ONLY_ACTIONS = ["edited"] as const;
export type PullRequestMetadataOnlyAction =
  (typeof PULL_REQUEST_METADATA_ONLY_ACTIONS)[number];

/** `installation.*` — App installed, uninstalled, suspended, or unsuspended. Handled by
 * the installation-sync path Prompt 4 builds; carries no PR/review implications itself. */
export const INSTALLATION_SYNC_ACTIONS = [
  "created",
  "deleted",
  "suspend",
  "unsuspend",
] as const;
export type InstallationSyncAction = (typeof INSTALLATION_SYNC_ACTIONS)[number];

/** `installation_repositories.*` — repositories added to or removed from an existing
 * installation's access, without the installation itself changing. */
export const INSTALLATION_REPOSITORIES_SYNC_ACTIONS = [
  "added",
  "removed",
] as const;
export type InstallationRepositoriesSyncAction =
  (typeof INSTALLATION_REPOSITORIES_SYNC_ACTIONS)[number];

/** `repository.*` — the connected repository itself was renamed, deleted, archived, or
 * unarchived on GitHub's side. */
export const REPOSITORY_SYNC_ACTIONS = [
  "renamed",
  "deleted",
  "archived",
  "unarchived",
] as const;
export type RepositorySyncAction = (typeof REPOSITORY_SYNC_ACTIONS)[number];

/**
 * The full matrix, keyed by `X-GitHub-Event`, each event's legal actions grouped by how
 * Prompt 2's router handles them. This is the single object a new triggering action is
 * added to — e.g. widening `pull_request.dispatch` to include `"assigned"` is the entire
 * change; nothing else in the codebase re-derives this list.
 *
 * `push` and `ping` have no action groups: neither event's handling depends on an action
 * at all (`push` carries no `action` field; `ping` is acknowledged unconditionally), so
 * there is nothing to enumerate beyond the event name itself being allowed.
 */
export const WEBHOOK_EVENT_MATRIX = {
  pull_request: {
    dispatch: REVIEW_TRIGGERING_ACTIONS,
    stateSync: PULL_REQUEST_STATE_SYNC_ACTIONS,
    metadataOnly: PULL_REQUEST_METADATA_ONLY_ACTIONS,
  },
  installation: {
    sync: INSTALLATION_SYNC_ACTIONS,
  },
  installation_repositories: {
    sync: INSTALLATION_REPOSITORIES_SYNC_ACTIONS,
  },
  repository: {
    sync: REPOSITORY_SYNC_ACTIONS,
  },
  push: {},
  ping: {},
} as const;

export type AllowedEventType = keyof typeof WEBHOOK_EVENT_MATRIX;

const ALLOWED_EVENT_TYPES = new Set<string>(Object.keys(WEBHOOK_EVENT_MATRIX));

/**
 * `true` iff `eventType` (the raw `X-GitHub-Event` header value) is one of this system's
 * allow-listed events. `false` covers both a plausible-but-unhandled GitHub event
 * (`issue_comment`, `check_run`, ...) and outright garbage — the router treats both
 * identically: see this file's header comment for the 200/no-row/warn-log reconciliation.
 */
export function isAllowedEvent(
  eventType: string,
): eventType is AllowedEventType {
  return ALLOWED_EVENT_TYPES.has(eventType);
}

/** Narrows a `pull_request` webhook's `action` field to the subset that should dispatch
 * a review. `undefined` (an action-less delivery, or a caller that hasn't read one yet)
 * never narrows — there is no action to be a review trigger. */
export function isReviewTriggeringAction(
  action: string | undefined,
): action is ReviewTriggeringAction {
  return (
    typeof action === "string" &&
    (REVIEW_TRIGGERING_ACTIONS as readonly string[]).includes(action)
  );
}
