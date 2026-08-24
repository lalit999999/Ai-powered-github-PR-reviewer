import {
  PROJECT_DELETED,
  REPOSITORY_INDEX_REQUESTED,
  type EventRegistry,
  type ProjectDeletedData,
  type RepositoryIndexRequestedData,
} from "@repo/shared";
import { eventType, staticSchema } from "inngest";

/**
 * Consumer-side view of the event contract (phase-00 §8, plan.md §27.1). The names and
 * payload shapes themselves live in `@repo/shared` (packages/shared/src/events.ts) so
 * `apps/api`, which *sends* these events, and this worker, which *consumes* them,
 * cannot drift apart. Extended per phase, never redesigned.
 *
 * `internal/noop.ping` (Phase 00's diagnostic-only trigger) is deliberately not part
 * of this registry: it's test-only and never sent in production. Phase 00 said to
 * delete it "once Phase 02 introduces the first real event" — Phase 02 introduces the
 * event but no function that *consumes* one, so the deletion moves to Phase 03. See
 * functions/noop.ts for the reasoning.
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
 * Phase 02 §8: `repository/index.requested`, defined with **no function consuming it**.
 *
 * Same forward-declaration pattern as `projectDeleted` above, and for the same reason:
 * the payload shape is settled here so Phase 03's `repository-index` function can be
 * written against a contract that already exists rather than negotiating one at that
 * point. Registering the *type* costs nothing and drifts nowhere; registering a
 * function would be Phase 03's work done early and badly.
 *
 * The acceptance signal for this phase is the event appearing in the Inngest Dev Server
 * UI with the right payload after a connect — precisely because nothing consumes it.
 */
export const repositoryIndexRequested = eventType(REPOSITORY_INDEX_REQUESTED, {
  schema: staticSchema<RepositoryIndexRequestedData>(),
});
