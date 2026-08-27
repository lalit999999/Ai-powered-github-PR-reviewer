import { parseProjectReviewSettings, type PullRequestReviewRequestedData } from "@repo/shared";
import {
  isReviewTriggeringAction,
  PULL_REQUEST_METADATA_ONLY_ACTIONS,
  PULL_REQUEST_STATE_SYNC_ACTIONS,
  type ReviewTriggeringAction,
} from "./event-allowlist.js";
import type { ParsedPullRequestEvent } from "./webhook.schema.js";
import type { UpsertPullRequestInput } from "./pull-request.repository.js";
import type { WebhookTenantTarget } from "../repositories/repository.repository.js";

/**
 * The pure decision core of Phase 06's webhook ingestion (phase-06 §4/§8, plan.md
 * §14.2, §34.3, §45). **This file is deliberately dependency-free of Prisma, logging,
 * Inngest, and the system clock beyond what is passed in** — no `@repo/db`, no
 * `@repo/observability`, no `@repo/github`, no `Date.now()`. Every rule this phase
 * encodes for `pull_request` deliveries lives here, in one function, so it is
 * exhaustively unit-testable without a database — see `event-router.test.ts`.
 *
 * `UpsertPullRequestInput` and `WebhookTenantTarget` are imported with `import type`
 * only: both are erased at compile time, so this file carries no runtime dependency on
 * either `*.repository.ts` module it borrows a shape from.
 */

export type IgnoreReason =
  | "NO_CONNECTED_REPOSITORY"
  | "ACTION_NOT_TRIGGERING"
  | "EDITED_METADATA_ONLY"
  | "DRAFT_SKIPPED"
  | "PING"
  | "PUSH_NOT_HANDLED_IN_MVP";

export type RouterDecision =
  | { kind: "DISPATCH"; events: PullRequestReviewRequestedData[]; pullRequestUpserts: UpsertPullRequestInput[] }
  | { kind: "PERSIST_ONLY"; pullRequestUpserts: UpsertPullRequestInput[]; reason: IgnoreReason }
  | { kind: "IGNORE"; reason: IgnoreReason };

function buildUpsert(tenant: WebhookTenantTarget, payload: ParsedPullRequestEvent): UpsertPullRequestInput {
  return {
    repositoryId: tenant.repositoryId,
    number: payload.pull_request.number,
    githubPrId: payload.pull_request.id,
    headSha: payload.pull_request.head.sha,
    state: payload.pull_request.state,
    isDraft: payload.pull_request.draft,
  };
}

/**
 * `${repositoryId}:${number}:${headSha}` — per **tenant**, not per delivery. This is
 * the detail that makes Inngest's own event-id dedup (Prompt 3) tenant-scoped rather
 * than accidentally collapsing the fan-out back into one event: two tenants for the
 * same GitHub PR get two different keys because `repositoryId` differs, even though
 * `number` and `headSha` are identical. Get this wrong — key on `number`/`headSha`
 * alone — and the fan-out silently stops working in production while every unit test
 * that only exercises one tenant at a time keeps passing.
 */
function buildPrKey(tenant: WebhookTenantTarget, payload: ParsedPullRequestEvent): string {
  return `${tenant.repositoryId}:${payload.pull_request.number}:${payload.pull_request.head.sha}`;
}

function buildEvent(
  tenant: WebhookTenantTarget,
  payload: ParsedPullRequestEvent,
  trigger: ReviewTriggeringAction,
  traceId: string,
): PullRequestReviewRequestedData {
  return {
    projectId: tenant.projectId,
    repositoryId: tenant.repositoryId,
    installationId: tenant.installationId.toString(),
    pullRequestNumber: payload.pull_request.number,
    headSha: payload.pull_request.head.sha,
    baseSha: payload.pull_request.base.sha,
    trigger,
    // §20: the first place a traceId crosses a process boundary, threaded verbatim
    // into every emitted payload — including every entry of a two-tenant fan-out.
    traceId,
    prKey: buildPrKey(tenant, payload),
  };
}

function isMetadataOnlyAction(action: string): boolean {
  return (PULL_REQUEST_METADATA_ONLY_ACTIONS as readonly string[]).includes(action);
}

function isStateSyncAction(action: string): boolean {
  return (PULL_REQUEST_STATE_SYNC_ACTIONS as readonly string[]).includes(action);
}

/**
 * Routes one already-verified, already-allow-listed `pull_request` delivery, resolved
 * against every tenant it affects, to a single decision.
 *
 * ## The rules, each traceable to its source
 *
 * 1. **Fan-out** (plan.md §34.3): `tenants.length === 2` produces **two** independent
 *    entries in `events` and **two** in `pullRequestUpserts` — never one event carrying
 *    two ids. Achieved structurally, by looping over `tenants` rather than by
 *    special-casing a count.
 * 2. **`opened`/`reopened`/`synchronize`/`ready_for_review` → dispatch** (F6, plan.md
 *    §4.1) — `isReviewTriggeringAction`, `event-allowlist.ts`'s own matrix.
 * 3. **`edited` → `PERSIST_ONLY` / `EDITED_METADATA_ONLY`** (plan.md §14.2, phase-06
 *    §4): a title/body edit is not a code change and never triggers a re-review.
 * 4. **`closed`/`converted_to_draft` → `PERSIST_ONLY`.** Reported as
 *    `ACTION_NOT_TRIGGERING` — there is no dedicated reason code for this pair, and
 *    reusing this one is accurate: both actions are allow-listed but neither is a
 *    review trigger. Cancelling an in-flight review for a PR that just closed is Phase
 *    07's job; there is nothing in this phase's own state for it to cancel yet, which is
 *    why no such handling appears here.
 * 5. **Draft gate, applied per tenant, not globally.** For every triggering action
 *    *except* `ready_for_review`, a tenant whose `pull_request.draft` is `true` and
 *    whose `ProjectReviewSettings.reviewDraftPullRequests` is `false` (the default)
 *    still gets a `PullRequest` upsert but no event. One project may opt into draft
 *    reviews while another, connected to the same repository, has not — the loop below
 *    makes that a per-iteration decision, so a mixed-tenant delivery correctly produces
 *    one event and two upserts, never zero and never two.
 * 6. **`ready_for_review` always dispatches**, regardless of what `pull_request.draft`
 *    says in the payload — that transition is the entire reason the action exists, so
 *    the draft check is skipped for it entirely rather than relying on the payload
 *    already reporting `draft: false`.
 * 7. **`tenants.length === 0` → `IGNORE` / `NO_CONNECTED_REPOSITORY`.** A delivery for a
 *    repository nobody has connected is normal — the GitHub App is installed on an
 *    account with many repositories — not an error. The log level for this is the
 *    service's call, not this function's; the distinct reason code is what lets the
 *    service choose `info` over `warn` without re-deriving the "is this actually fine"
 *    judgment itself.
 */
export function routePullRequestEvent(args: {
  payload: ParsedPullRequestEvent;
  tenants: readonly WebhookTenantTarget[];
  traceId: string;
}): RouterDecision {
  const { payload, tenants, traceId } = args;

  if (tenants.length === 0) {
    return { kind: "IGNORE", reason: "NO_CONNECTED_REPOSITORY" };
  }

  const pullRequestUpserts = tenants.map((tenant) => buildUpsert(tenant, payload));
  const action = payload.action;

  if (isMetadataOnlyAction(action)) {
    return { kind: "PERSIST_ONLY", pullRequestUpserts, reason: "EDITED_METADATA_ONLY" };
  }

  if (isStateSyncAction(action)) {
    return { kind: "PERSIST_ONLY", pullRequestUpserts, reason: "ACTION_NOT_TRIGGERING" };
  }

  if (!isReviewTriggeringAction(action)) {
    // Unreachable while event-allowlist.ts's pull_request matrix stays exhaustive
    // (dispatch | stateSync | metadataOnly cover every allow-listed action) — kept as
    // an explicit default rather than falling through to a dispatch, so a future
    // allow-listed action added to the matrix without a matching router branch fails
    // safe (persists, does not review) instead of failing open.
    return { kind: "PERSIST_ONLY", pullRequestUpserts, reason: "ACTION_NOT_TRIGGERING" };
  }

  const events: PullRequestReviewRequestedData[] = [];
  for (const tenant of tenants) {
    if (action !== "ready_for_review" && payload.pull_request.draft) {
      const settings = parseProjectReviewSettings(tenant.projectSettings);
      if (!settings.reviewDraftPullRequests) {
        continue;
      }
    }
    events.push(buildEvent(tenant, payload, action, traceId));
  }

  if (events.length === 0) {
    return { kind: "PERSIST_ONLY", pullRequestUpserts, reason: "DRAFT_SKIPPED" };
  }

  return { kind: "DISPATCH", events, pullRequestUpserts };
}
