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
export const CONNECTION_STATUSES = [
  "ACTIVE",
  "DISCONNECTED",
  "ACCESS_LOST",
] as const;

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
  return (
    typeof value === "string" &&
    (CONNECTION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * A `Repository` row as the repository layer returns it — Postgres/Prisma types
 * (`bigint`, `Date`, raw `Json`), never sent to a client as-is. Mirrors
 * `ProjectRecord`: the repository imports this, not the other way round.
 *
 * The two `bigint` fields are the reason `toRepositoryDto` below exists at all.
 */
export interface RepositoryRecord {
  id: string;
  projectId: string;
  installationId: bigint;
  githubRepoId: bigint;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  htmlUrl: string;
  sizeBytes: number | null;
  connectionStatus: string;
  indexStatus: string;
  indexedCommitSha: string | null;
  indexVersion: number;
  indexedFileCount: number;
  skippedFileCount: number;
  lastIndexedAt: Date | null;
  /** Phase 03: `{ code, message }`, or `null` when the last run (if any) did not fail.
   * See index-job.repository.ts's IndexJobRecord.error for the identical shape. */
  indexError: unknown;
  settings: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The minimal projection `requireTenantAccess` needs to decide ownership of a
 * repository, with the owning `userId` resolved through the `Repository → Project`
 * join in a single query (plan.md §34.2).
 *
 * Same discipline as `ProjectOwnership`: exactly the columns the decision is made
 * from, and nothing else. `projectId` is here because the tenancy check returns it in
 * the `TenantContext` (a repository context always names its project too), and
 * `project.deletedAt` because a repository under a soft-deleted project must render
 * as not-found just like the project itself does.
 */
export interface RepositoryOwnership {
  id: string;
  projectId: string;
  userId: string;
  projectDeletedAt: Date | null;
}

/**
 * What the API actually returns. Hand-written field by field, never a `...record`
 * spread, for the reason `project.types.ts`'s doc comment warned about and this phase
 * makes real:
 *
 * **`installationId` and `githubRepoId` are `bigint` in the database and `string`
 * here.** `JSON.stringify` *throws* on a bigint (`TypeError: Do not know how to
 * serialize a BigInt`), so a DTO that carried one through would be a runtime 500 on
 * the happy path, in production, on the very first successful connect. phase-01-log
 * §4 settled the policy: convert to `string` explicitly at the DTO boundary, field by
 * field — no global `BigInt.prototype.toJSON` monkey-patch (which would silently
 * change serialization for every consumer, including ones that want to fail loudly).
 *
 * `repository.controller.test.ts` asserts `JSON.stringify(dto)` does not throw, so a
 * future field added by spread cannot reintroduce this quietly.
 */
export interface RepositoryDto {
  id: string;
  projectId: string;
  /** `bigint` in Postgres — a decimal string here. See the type doc above. */
  installationId: string;
  /** `bigint` in Postgres — a decimal string here. See the type doc above. */
  githubRepoId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  htmlUrl: string;
  sizeBytes: number | null;
  connectionStatus: ConnectionStatus;
  indexStatus: string;
  indexedCommitSha: string | null;
  indexedFileCount: number;
  lastIndexedAt: string | null;
  /** Phase 03: see `RepositoryRecord.indexError`'s doc comment. */
  indexError: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * An `IndexJob` row as `index-job.repository.ts` returns it — same discipline as
 * `RepositoryRecord` above: the repository layer imports this shape, never the other
 * way round.
 */
export interface IndexJobRecord {
  id: string;
  repositoryId: string;
  mode: string;
  status: string;
  currentStep: string | null;
  progressPercent: number;
  filesTotal: number;
  filesProcessed: number;
  filesSkipped: number;
  error: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

/**
 * `GET /api/repositories/:id`'s `indexJob` field. `status`/`error` are left as the raw
 * `string`/`unknown` shapes the row carries (`IndexJobStatus`/the `{code,message,step}`
 * JSON) rather than narrowed here; the client already has `@repo/shared`'s
 * `IndexJobStatus` union if it wants to narrow client-side, and re-deriving that
 * narrowing on the API's read path buys nothing a hand-edited row wouldn't just make lie
 * anyway (same reasoning `toRepositoryDto`'s own `indexStatus: string` field uses).
 */
export interface IndexJobSummaryDto {
  id: string;
  status: string;
  currentStep: string | null;
  progressPercent: number;
  filesTotal: number;
  filesProcessed: number;
  filesSkipped: number;
  error: unknown;
}

export function toIndexJobSummaryDto(
  record: IndexJobRecord,
): IndexJobSummaryDto {
  return {
    id: record.id,
    status: record.status,
    currentStep: record.currentStep,
    progressPercent: record.progressPercent,
    filesTotal: record.filesTotal,
    filesProcessed: record.filesProcessed,
    filesSkipped: record.filesSkipped,
    error: record.error,
  };
}

/**
 * `GET /api/repositories/:id/index-status` (§7)'s response — deliberately its own,
 * lighter type rather than reusing `IndexJobSummaryDto`: §7 names exactly these six
 * fields (no `id`, no `filesSkipped` — both are derivable or unneeded for a cheap poll),
 * and a repository with no `IndexJob` row yet (see `getIndexStatus`'s own doc comment)
 * has no real job `id` to report at all — better to not have the field than to fake one.
 */
export interface IndexStatusDto {
  status: string;
  currentStep: string | null;
  progressPercent: number;
  filesTotal: number;
  filesProcessed: number;
  error: unknown;
}

/**
 * `GET /api/repositories/:id` response body (phase-02 §7, widened in Phase 03).
 *
 * `indexJob` was **always** `null` before this phase — the literal `null` type (rather
 * than `unknown` or an optional field) was deliberate, forcing this exact widening to be
 * a **compile error** at every call site rather than a silent no-op
 * (`docs/decisions/phase-02-log.md` §26). `null` remains a real value here: a repository
 * that has never had an index run (freshly connected, before `repository/index.requested`
 * is even processed) has no `IndexJob` row to summarize yet.
 */
export interface RepositoryDetail {
  repository: RepositoryDto;
  indexJob: IndexJobSummaryDto | null;
}

/** Narrows a `connectionStatus` column value read back from Postgres, falling back to
 * the schema default rather than throwing — a hand-edited row must not 500 a read. */
function toConnectionStatus(value: string): ConnectionStatus {
  return isConnectionStatus(value) ? value : CONNECTION_STATUS.ACTIVE;
}

export function toRepositoryDto(record: RepositoryRecord): RepositoryDto {
  return {
    id: record.id,
    projectId: record.projectId,
    // The two explicit bigint → string conversions this whole file exists for.
    installationId: record.installationId.toString(),
    githubRepoId: record.githubRepoId.toString(),
    owner: record.owner,
    name: record.name,
    fullName: record.fullName,
    defaultBranch: record.defaultBranch,
    isPrivate: record.isPrivate,
    htmlUrl: record.htmlUrl,
    sizeBytes: record.sizeBytes,
    connectionStatus: toConnectionStatus(record.connectionStatus),
    indexStatus: record.indexStatus,
    indexedCommitSha: record.indexedCommitSha,
    indexedFileCount: record.indexedFileCount,
    lastIndexedAt: record.lastIndexedAt?.toISOString() ?? null,
    indexError: record.indexError,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * A `GithubInstallation` row as the repository layer returns it. `installationId` is
 * the GitHub-global id and is a `bigint`, with the same conversion rule as above.
 */
export interface InstallationRecord {
  id: string;
  installationId: bigint;
  accountLogin: string;
  accountType: string;
  userId: string;
  suspendedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** `GET /api/github/installations` element (phase-02 §7). */
export interface InstallationDto {
  id: string;
  /** `bigint` in Postgres — a decimal string here. */
  installationId: string;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toInstallationDto(record: InstallationRecord): InstallationDto {
  return {
    id: record.id,
    installationId: record.installationId.toString(),
    accountLogin: record.accountLogin,
    accountType: record.accountType,
    // `suspendedAt` is a timestamp internally; the API only needs the boolean, and
    // exposing the exact moment GitHub suspended an App tells the client nothing
    // actionable.
    suspended: record.suspendedAt !== null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * One entry in the repository picker (phase-02 §7:
 * `GET /api/github/installations/:id/repos`). Comes straight from GitHub, never from
 * the database — these are repositories the installation can see, most of which are
 * not connected to anything.
 */
export interface InstallationRepositoryDto {
  /** `bigint` from GitHub — a decimal string here. */
  githubRepoId: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
}

/**
 * The shape `webhook-event.repository.ts`'s (webhooks module) `WebhookEventRecord`
 * carries — declared locally, structurally, rather than imported, so this
 * "dependency-free" types file (see its own header comment: "the repository layer
 * imports these, never the reverse") does not take a cross-module dependency in the
 * wrong direction just to name a parameter type. Any `WebhookEventRecord` already
 * satisfies this shape.
 */
interface WebhookDeliveryRecord {
  id: string;
  deliveryId: string;
  eventType: string;
  action: string | null;
  status: string;
  dispatchedAt: Date | null;
  error: unknown;
  createdAt: Date;
}

/**
 * `POST /api/repositories/:id/webhook-test`'s (phase-06 §7) response element — despite
 * the route's name, this reads recorded `WebhookEvent` rows, it does not send anything
 * (see `repository.service.ts`'s `listRecentWebhookDeliveries` for the fuller argument).
 *
 * Hand-written field by field from `WebhookDeliveryRecord` above, never a `...record`
 * spread — the identical discipline `toRepositoryDto` above uses, for the identical
 * reason: today's `WEBHOOK_EVENT_SELECT` carries no `bigint` column (`installationId` is
 * deliberately not selected for this read), but a future column added to that select
 * list must fail here, not surface as an unserializable field in a JSON response.
 */
export interface WebhookDeliveryDto {
  id: string;
  deliveryId: string;
  eventType: string;
  action: string | null;
  status: string;
  dispatchedAt: string | null;
  error: unknown;
  createdAt: string;
}

export function toWebhookDeliveryDto(
  record: WebhookDeliveryRecord,
): WebhookDeliveryDto {
  return {
    id: record.id,
    deliveryId: record.deliveryId,
    eventType: record.eventType,
    action: record.action,
    status: record.status,
    dispatchedAt: record.dispatchedAt?.toISOString() ?? null,
    error: record.error,
    createdAt: record.createdAt.toISOString(),
  };
}
