import type { RepositoryDto } from "../repositories/repository.types.js";

/**
 * Domain and DTO types for the projects module. Deliberately dependency-free: the
 * repository imports these, not the other way round, so nothing Prisma-shaped can leak
 * upward through this file.
 */

/**
 * A `Project` row as the repository layer returns it — Postgres/Prisma types
 * (`Date`, raw `Json`), never sent to a client as-is.
 */
export interface ProjectRecord {
  id: string;
  userId: string;
  name: string;
  slug: string;
  settings: unknown;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The minimal projection `requireTenantAccess` needs to decide ownership. Kept
 * separate from `ProjectRecord` so the tenancy check reads exactly the three columns
 * it makes its decision from and nothing else.
 */
export interface ProjectOwnership {
  id: string;
  userId: string;
  deletedAt: Date | null;
}

/**
 * What the API actually returns. Two rules hold here and are the reason this is a
 * hand-written field-by-field mapping rather than a spread of the row:
 *
 * 1. **BigInt never reaches `JSON.stringify` unconverted.** `JSON.stringify` throws on
 *    a bigint, so a DTO carrying one is a runtime 500 (docs/decisions/phase-01-log.md
 *    §4 settled this: convert to `string` at the API/DTO boundary, no global
 *    `BigInt.prototype.toJSON` monkey-patch). `Project` has no BigInt column today, so
 *    there is nothing to convert *yet* — but Phase 02's `githubRepoId`/`installationId`
 *    do, and an explicit mapping forces whoever adds them to make that conversion
 *    deliberately. A `...record` spread would have silently shipped a bigint.
 * 2. **`userId` is not in the DTO.** The caller is the owner by construction (every
 *    route resolves tenancy first), so echoing it back adds nothing and would make a
 *    future response-shape change the moment tenancy stops meaning "owner".
 *
 * `deletedAt` is likewise absent: every project the API returns is non-deleted by
 * construction, so the field could only ever be `null`.
 */
export interface ProjectDto {
  id: string;
  name: string;
  slug: string;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/projects` response body (phase-01 §7). */
export interface ProjectListPage {
  projects: ProjectDto[];
  nextCursor: string | null;
}

/**
 * `GET /api/projects/:id` response body (phase-01 §7).
 *
 * `repositories` was typed `never[]` through Phase 01 precisely so that Phase 02 — the
 * phase that introduces the `Repository` model — could not leave it as an empty array
 * by accident: assigning a real DTO to `never[]` is a compile error, not a silent
 * no-op. The marker did its job; this is the widening it was there to force.
 *
 * Scoped to the project's **active** repositories: `DISCONNECTED` rows are excluded,
 * `ACCESS_LOST` ones are not (see `repository.repository.listByProject`).
 */
export interface ProjectDetail {
  project: ProjectDto;
  repositories: RepositoryDto[];
}

/**
 * Prisma types `Json` columns as a union that includes arrays and scalars. `settings`
 * is specified as an object (`@default("{}")`, phase-01 §6), but a hand-edited row
 * could hold anything, so this narrows defensively instead of casting.
 */
function toSettings(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function toProjectDto(record: ProjectRecord): ProjectDto {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    settings: toSettings(record.settings),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
