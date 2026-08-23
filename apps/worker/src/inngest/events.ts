import { PROJECT_DELETED, type EventRegistry, type ProjectDeletedData } from "@repo/shared";
import { eventType, staticSchema } from "inngest";

/**
 * Consumer-side view of the event contract (phase-00 §8, plan.md §27.1). The names and
 * payload shapes themselves live in `@repo/shared` (packages/shared/src/events.ts) so
 * `apps/api`, which *sends* these events, and this worker, which *consumes* them,
 * cannot drift apart. Extended per phase, never redesigned.
 *
 * `internal/noop.ping` (this phase's diagnostic-only trigger) is deliberately not part
 * of this registry: it's test-only, never sent in production, and is deleted once
 * Phase 02 introduces the first real consumed event (phase-00 §8).
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
