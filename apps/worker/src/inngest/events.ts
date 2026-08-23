/**
 * Typed event registry for real product events (phase-00 §8, plan.md §27.1) — empty
 * until Phase 02 defines the first one (`repository/index.requested`). Extended per
 * phase, never redesigned.
 *
 * `internal/noop.ping` (this phase's diagnostic-only trigger) is deliberately not
 * part of this registry: it's test-only, never sent in production, and is deleted
 * once Phase 02 introduces the first real event (phase-00 §8).
 */
export type Events = Record<string, never>;
