/**
 * Domain types for the repositories module (Phase 02). Deliberately dependency-free,
 * matching project.types.ts: the repository layer imports these, never the reverse, so
 * nothing Prisma-shaped leaks upward.
 *
 * Prompt 1 of this phase only establishes the type-level contract the schema needs —
 * the record/DTO shapes, the service, and the routes land in Prompt 2.
 */

/**
 * `Repository.connectionStatus` is a plain `String` column with an `"ACTIVE"` default,
 * while `indexStatus` next to it is a real Postgres enum. That asymmetry comes from
 * both source documents (phase-02 §6 and plan.md §24.2) and is followed rather than
 * "corrected" — but it means the database will accept any string at all, so the legal
 * values are pinned here and every write in the API layer goes through this union.
 *
 * See docs/decisions/phase-02-log.md §7 for why the asymmetry was kept.
 */
export const CONNECTION_STATUSES = ["ACTIVE", "DISCONNECTED", "ACCESS_LOST"] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/**
 * `ACTIVE → DISCONNECTED` on `DELETE /api/repositories/:id`; `ACTIVE → ACCESS_LOST`
 * when an installation-token mint comes back 401 (phase-02 §11). The transition itself
 * is the service layer's job in Prompt 2 — the GitHub client only produces the typed
 * error that identifies the case.
 */
export const CONNECTION_STATUS = {
  ACTIVE: "ACTIVE",
  DISCONNECTED: "DISCONNECTED",
  ACCESS_LOST: "ACCESS_LOST",
} as const satisfies Record<ConnectionStatus, ConnectionStatus>;

/** Narrows an arbitrary column value read back from Postgres. */
export function isConnectionStatus(value: unknown): value is ConnectionStatus {
  return typeof value === "string" && (CONNECTION_STATUSES as readonly string[]).includes(value);
}
