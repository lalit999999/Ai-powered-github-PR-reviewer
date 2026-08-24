import { AsyncLocalStorage } from "node:async_hooks";
import { ulid } from "ulid";

/**
 * Mirrors apps/api/src/lib/tracing.ts's shape exactly (same envelope, same
 * AsyncLocalStorage pattern) so worker function logs match the Phase 00 §20 envelope.
 * Deliberately duplicated rather than shared via a new packages/shared module — see
 * docs/decisions/phase-01-log.md for why (apps/worker has exactly one diagnostic
 * function this phase; extracting a shared package is the right move once it has
 * more than that, starting Phase 03).
 */
export interface TraceContext {
  traceId: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<TraceContext>();

export function generateTraceId(): string {
  return ulid();
}

export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}
