import { AsyncLocalStorage } from "node:async_hooks";
import { ulid } from "ulid";

/**
 * Sortable (ULID) trace id + AsyncLocalStorage context. Deliberately an index-signature
 * type so Phase 01 can add `userId`/`projectId` to the context without changing any call
 * site that only cares about `traceId` (see docs/decisions/phase-00-log.md §1 — this repo's
 * apps/api is a plain Node/Express process, so ALS is reliable end-to-end; the Edge-runtime
 * caveat in phase-00 §5 doesn't apply here).
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
