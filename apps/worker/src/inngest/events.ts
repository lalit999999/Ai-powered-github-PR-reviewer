import {
  PROJECT_DELETED,
  PULL_REQUEST_CLOSED,
  PULL_REQUEST_REVIEW_REQUESTED,
  REPOSITORY_INDEXED,
  REPOSITORY_INDEX_REQUESTED,
  type EventRegistry,
  type ProjectDeletedData,
  type PullRequestClosedData,
  type PullRequestReviewRequestedData,
  type RepositoryIndexedData,
  type RepositoryIndexRequestedData,
} from "@repo/shared";
import { eventType, staticSchema } from "inngest";

/**
 * Consumer-side view of the event contract (phase-00 §8, plan.md §27.1). The names and
 * payload shapes themselves live in `@repo/shared` (packages/shared/src/events.ts) so
 * `apps/api`, which *sends* these events, and this worker, which *consumes* them,
 * cannot drift apart. Extended per phase, never redesigned.
 *
 * `internal/noop.ping` (Phase 00's diagnostic-only trigger) no longer has any
 * representation here or anywhere else in the worker — `functions/noop.ts` and its
 * registration in `app.ts` are deleted in Phase 03, now that `repository-index`
 * (registered below) proves the worker is discoverable better than the noop ever could
 * (see functions/repository-index.ts and docs/decisions/phase-03-log.md).
 */
export type Events = EventRegistry;

/**
 * Phase 01 §8: `project/deleted`, defined with **no function consuming it**.
 *
 * This is the forward-declaration pattern Phase 00 used for its no-op function: settle
 * the event contract now so Phase 03 onward can attach `cancelOn: [projectDeleted]`
 * handlers to cancel in-flight work for a deleted project, without having to
 * renegotiate the payload at that point. Nothing reacts to it today — there is no
 * cancellable background work in this phase to react with.
 *
 * `staticSchema` gives compile-time payload typing with a pass-through runtime
 * validator: it is a type contract, not an input-validation boundary (the API's Zod
 * schemas are that). Inngest v4 has no client-level `schemas` option, so typing is
 * declared per event here rather than on the client.
 */
export const projectDeleted = eventType(PROJECT_DELETED, {
  schema: staticSchema<ProjectDeletedData>(),
});

/**
 * Phase 02 §8: `repository/index.requested`. **Phase 03 is the first function to
 * consume it** — `functions/repository-index.ts` triggers on this exact `eventType`,
 * which is why the forward declaration existed at all: the payload shape was settled
 * two phases before anything read it, so nothing had to renegotiate it now.
 */
export const repositoryIndexRequested = eventType(REPOSITORY_INDEX_REQUESTED, {
  schema: staticSchema<RepositoryIndexRequestedData>(),
});

/**
 * Phase 03 §8/§10: `repository/indexed`, defined with **no function consuming it** —
 * the same forward-declaration pattern as `projectDeleted` above. `repository-index.ts`
 * emits it as its final step; Phase 04 (knowledge graph) and Phase 07 (PR ingestion)
 * are its real consumers. The acceptance signal for this phase is the same as it was
 * for `repository/index.requested` two phases ago: the event appearing in the Inngest
 * Dev Server UI with the right payload, because nothing consumes it yet.
 */
export const repositoryIndexed = eventType(REPOSITORY_INDEXED, {
  schema: staticSchema<RepositoryIndexedData>(),
});

/**
 * Phase 06 §8: `pull-request/review.requested`, defined with **no function consuming
 * it** — the same forward-declaration pattern `projectDeleted` and `repositoryIndexed`
 * above already use twice in this file, not a third, coincidentally similar decision.
 * Phase 07 registers the first consumer (`pull-request-process`). The acceptance signal
 * for this phase is the same one Phase 02 and Phase 03 used for their own forward
 * declarations: the event appearing in the Inngest Dev Server UI with the correct
 * payload, because nothing reads it yet.
 */
export const pullRequestReviewRequested = eventType(
  PULL_REQUEST_REVIEW_REQUESTED,
  {
    schema: staticSchema<PullRequestReviewRequestedData>(),
  },
);

/**
 * Phase 07 sub-task 1.3: `pull-request/closed`, defined with **no function consuming it
 * yet** — the same forward-declaration pattern this file already uses three times above.
 * A later Phase 07 prompt attaches `cancelOn: [{ event: pullRequestClosed, if:
 * "async.data.prRef == event.data.prRef" }]` to the review-processing function, matching
 * `pull-request/review.requested`'s own doc comment on why `prRef` — not `prKey` — is the
 * field a cancellation predicate has to key on.
 */
export const pullRequestClosed = eventType(PULL_REQUEST_CLOSED, {
  schema: staticSchema<PullRequestClosedData>(),
});
