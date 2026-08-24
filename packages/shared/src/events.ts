/**
 * The Inngest event contract — the one place an event's name and payload shape are
 * defined, shared by the sender (`apps/api`) and the consumer (`apps/worker`).
 *
 * This package holds *only* type-level contracts and constants: it has no runtime
 * dependencies, so importing it can never drag Inngest, Prisma, or a logger into a
 * deployable that doesn't want them. The Inngest trigger objects built from these
 * declarations live in `apps/worker/src/inngest/events.ts` (consumer side) and the
 * send helpers in `apps/api/src/inngest/emit.ts` (producer side).
 *
 * Why a shared package rather than duplicating the shape on both sides: an event
 * contract is exactly the thing that must not drift. (docs/decisions/phase-00-log.md
 * §9 deferred `packages/shared` when the only candidate was a diagnostic logger; a
 * cross-deployable contract is a different and better reason — see
 * docs/decisions/phase-01-log.md §14.)
 *
 * Extended per phase, never redesigned.
 */

/**
 * Phase 01 §8. Emitted by `DELETE /api/projects/:id` after a project transitions to
 * SOFT_DELETED. **Deliberately has no consumer yet** — it is a forward declaration so
 * the payload shape is settled before Phase 03 registers `cancelOn` handlers keyed to
 * it. Do not write a handler for it in this phase.
 */
export const PROJECT_DELETED = "project/deleted";

/** Payload of {@link PROJECT_DELETED}. A `type` (not an `interface`) so it satisfies
 * `Record<string, unknown>`, which Inngest's `staticSchema<T>()` requires. */
export type ProjectDeletedData = { projectId: string };

/**
 * Phase 02 §8. Emitted by `POST /api/projects/:id/repositories` after a `Repository`
 * row is created in `indexStatus: PENDING`.
 *
 * **Deliberately has no consumer in Phase 02** — §8 states that Phase 03 registers the
 * first function (`repository-index`), and the acceptance signal for this phase's
 * Inngest work is simply seeing the event land in the Dev Server UI with the right
 * payload. Do not write a handler for it in this phase.
 */
export const REPOSITORY_INDEX_REQUESTED = "repository/index.requested";

/**
 * Payload of {@link REPOSITORY_INDEX_REQUESTED}. A `type` (not an `interface`) so it
 * satisfies `Record<string, unknown>`, which Inngest's `staticSchema<T>()` requires.
 *
 * `mode` and `reason` are literal-typed rather than plain strings even though each has
 * exactly one value today. Phase 03 adds `mode: "INCREMENTAL"` (a webhook-driven
 * re-index) and Phase 06 adds `reason: "webhook"`; declaring them as unions now means
 * those additions are a one-line widening whose every `switch` becomes a compile error
 * — as opposed to `string`, where a new value silently falls through whatever `else`
 * the handler happens to have.
 *
 * `projectId` rides along with `repositoryId` even though the repository row names its
 * project: a consumer that had to look it up would be making a database round trip
 * inside a step just to know which tenant it is working for.
 */
export type RepositoryIndexRequestedData = {
  projectId: string;
  repositoryId: string;
  mode: "FULL";
  reason: "connected";
};

/**
 * Every product event this system defines, keyed by event name. Later phases append
 * their own. Kept as a plain type
 * registry because Inngest v4 has no client-level `schemas` option — typing is
 * per-event via `eventType()` (verified against the installed inngest@4.18.1's
 * `ClientOptions`, which has no `schemas` field; the v3 `EventSchemas.fromRecord`
 * API no longer exists).
 */
export type EventRegistry = {
  "project/deleted": { data: ProjectDeletedData };
  "repository/index.requested": { data: RepositoryIndexRequestedData };
};

/** Event names as a union — useful anywhere a name must be one of the declared events. */
export type EventName = keyof EventRegistry;
