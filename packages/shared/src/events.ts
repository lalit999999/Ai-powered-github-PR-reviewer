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
  /** `"connected"` — `repositoryService.connectRepository` (Phase 02). `"manual"` —
   * `POST /api/repositories/:id/index` (Phase 03 §7, `repositoryService.triggerIndex`).
   * `"sweep"` — `stale-index-sweeper` (Phase 03, `apps/worker`'s own cron function,
   * `plan.md` §27.2), re-requesting an index for a repository stuck `PENDING` because
   * its original `"connected"` event was dropped — the resolution to `emit.ts`'s
   * `TODO(phase-03)`; see that file and docs/decisions/phase-03-log.md. Phase 06 adds
   * `"webhook"`, per this field's original forward-declared comment. */
  reason: "connected" | "manual" | "sweep";
  /**
   * Phase 03 addition. `POST /api/repositories/:id/index` must return `{ indexJobId }`
   * synchronously (§7) — before the worker's own step 1 has run and created the row —
   * so the API pre-generates the id and the worker's `createIndexJob` adopts it instead
   * of generating its own. Absent on the `"connected"` path: `connectRepository` has no
   * synchronous caller waiting on a job id (§7's connect response is just
   * `{ repository }`), so there is nothing to pre-allocate for. See
   * docs/decisions/phase-03-log.md for the full argument, including the narrow,
   * accepted race this creates (the pre-allocated id can go unused if this run loses
   * the lock to a concurrent one — cosmetic, since neither route requires the client to
   * poll *by* this id; both poll `/index-status`, which is scoped to the repository).
   */
  indexJobId?: string;
};

/**
 * Phase 03 §8/§10 ("Emit repository.indexed — no consumer until Phase 04/07"). The
 * terminal step of `repository-index` emits this once `Repository.indexStatus` has
 * moved to `INDEXED` (this phase's limited sense — see phase-03-repository-indexing.md
 * §1) and the row is committed. As with the two forward-declared events above, no
 * function in this phase consumes it — Phase 04 (knowledge graph) and Phase 07
 * (PR ingestion, "waiting reviews" in `plan.md` §27.1's own table) are its real
 * consumers, and the payload is settled now specifically so neither has to renegotiate
 * it later.
 *
 * `projectId` rides along for the same reason `RepositoryIndexRequestedData`'s own
 * payload does (see its doc comment) — a consumer scoping work to a tenant should not
 * need a database round trip just to learn which one. `fileCount`/`durationMs` are
 * `plan.md` §27.1's own named fields for this event: cheap summary stats a
 * UI-invalidation consumer wants without re-querying `IndexJob`.
 */
export const REPOSITORY_INDEXED = "repository/indexed";

export type RepositoryIndexedData = {
  projectId: string;
  repositoryId: string;
  commitSha: string;
  fileCount: number;
  durationMs: number;
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
  "repository/indexed": { data: RepositoryIndexedData };
};

/** Event names as a union — useful anywhere a name must be one of the declared events. */
export type EventName = keyof EventRegistry;
