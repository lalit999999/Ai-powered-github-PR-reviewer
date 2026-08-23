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

/**
 * Phase 01 §20: once a request resolves a session, every subsequent log line in its
 * call graph should carry `userId` too — without redesigning the envelope or
 * re-threading it manually. Mutates the store object already established by
 * runWithTraceContext for this request (AsyncLocalStorage's `.run()` fixes the store
 * *reference* for the callback's duration, not its contents), so it takes effect for
 * every createLogger() call made afterwards in the same request, with no new context
 * scope needed. A no-op outside a trace context (e.g. a unit test calling this
 * directly) rather than throwing — setting user context is best-effort, never a
 * reason to fail a request.
 */
export function setTraceUserId(userId: string): void {
  const context = storage.getStore();
  if (context) {
    context.userId = userId;
  }
}
