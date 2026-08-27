import { randomUUID } from "node:crypto";
import { createLogger } from "@repo/observability";
import type { StalePendingRepository } from "../../indexing/persistence/repository.repository.js";
import * as repositoryRepository from "../../indexing/persistence/repository.repository.js";
import { inngest } from "../client.js";
import { repositoryIndexRequested } from "../events.js";

/**
 * `plan.md` §27.2's named `stale-index-sweeper` cron — the resolution to
 * `apps/api/src/inngest/emit.ts`'s `TODO(phase-03)`. That file argues at length that
 * `emitRepositoryIndexRequested` staying fire-and-forget is fine *because* "the durable
 * record is the row, not the event" and Phase 03 is what "reconciles from directly —
 * find repositories PENDING with no job and enqueue one". This function is that
 * reconciliation.
 *
 * ## Why a cron sweep and not a transactional outbox
 *
 * `emit.ts`'s own TODO named two options: "a transactional outbox plus a reconcile
 * sweep". This phase builds only the sweep. An outbox (writing the outgoing event to the
 * same Postgres transaction as the row it describes, then a separate dispatcher reading
 * and sending unsent rows) is strictly more correct — it would catch a dropped event
 * within seconds instead of up to 6 hours — but it is a real, standalone piece of
 * infrastructure (a table, a dispatcher, idempotent-send bookkeeping) that touches every
 * future event emission in this codebase, not just this one. `plan.md` §27.2 names the
 * sweep specifically, on its own, as a cron function in the catalogue — the outbox is
 * not named anywhere in that catalogue or in this phase's own §3 scope list. Building
 * the sweep now and the outbox later (if a 6-hour worst case ever proves too slow in
 * practice) is the smaller, named, load-bearing piece; the outbox is a bigger
 * architectural investment this phase does not ask for. Recorded here as a deliberate
 * choice, not an oversight — see docs/decisions/phase-03-log.md.
 *
 * ## Why this is safe to run against a repository that is not actually stuck
 *
 * `findStalePending` (repository.repository.ts) is a heuristic, not a proof: a
 * repository whose real index run is in flight but has not yet updated `indexStatus`
 * away from `PENDING` looks identical to a genuinely dropped event. Re-emitting
 * `repository/index.requested` for it is harmless — `repository-index.ts`'s own lock
 * (§11/§12) means the redundant event simply fails to acquire the lock and the second
 * run exits gracefully, exactly as it would for any other concurrent trigger.
 */

const STALE_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Pure — no `step`/Inngest dependency — so it is unit-testable directly, matching
 * `repository-index.ts`'s own `runFetchExtractPersist`/`withCode`/`parseCode` seams.
 * One event per stale repository, each with its own freshly-generated `indexJobId`
 * (the same pre-allocation `triggerIndex` uses — see `@repo/shared`'s
 * `RepositoryIndexRequestedData.indexJobId` doc comment).
 */
export function buildSweepEvents(stale: readonly StalePendingRepository[]): {
  name: typeof repositoryIndexRequested.name;
  data: {
    projectId: string;
    repositoryId: string;
    mode: "FULL";
    reason: "sweep";
    indexJobId: string;
  };
}[] {
  return stale.map((repository) => ({
    name: repositoryIndexRequested.name,
    data: {
      projectId: repository.projectId,
      repositoryId: repository.id,
      mode: "FULL" as const,
      reason: "sweep" as const,
      indexJobId: randomUUID(),
    },
  }));
}

export const staleIndexSweeper = inngest.createFunction(
  {
    id: "stale-index-sweeper",
    retries: 1,
    timeouts: { finish: "5m" },
    triggers: { cron: "0 */6 * * *" },
  },
  async ({ step }) => {
    const logger = createLogger("indexing.stale-index-sweeper");

    const stale = await step.run("find-stale-pending", () =>
      repositoryRepository.findStalePending(STALE_THRESHOLD_MS),
    );

    if (stale.length === 0) {
      logger.info("stale-index-sweeper found nothing to sweep");
      return { swept: 0 };
    }

    logger.warn(
      "stale-index-sweeper re-requesting indexing for repositories stuck PENDING",
      {
        count: stale.length,
        repositoryIds: stale.map((repository) => repository.id),
      },
    );

    await step.sendEvent("re-request-stale-indexes", buildSweepEvents(stale));

    return { swept: stale.length };
  },
);
