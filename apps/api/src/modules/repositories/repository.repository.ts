import { prisma } from "@repo/db";
import type {
  RepositoryOwnership,
  RepositoryRecord,
} from "./repository.types.js";

/**
 * Prisma queries only — no business logic, no logging, no error translation beyond
 * turning Prisma's own constraint-violation shape into a domain-level result (see
 * `create` below). Only files matching `*.repository.ts` (and `packages/db/**`) may
 * import `@repo/db`'s Prisma-backed exports (Rule B, phase-00 §3).
 *
 * ## Query keying — the named failure point, and the rule that answers it
 *
 * `plan.md` §45 names **"assuming `githubRepoId` is globally unique"** as one of two
 * ways Phase 02 goes wrong. It is not globally unique here, deliberately: phase-02 §4
 * requires that the *same* GitHub repository can be connected to two *different*
 * projects, and both connections work independently. The schema says so
 * (`@@unique([projectId, githubRepoId])`, not `@unique` on `githubRepoId`).
 *
 * > **Every repository lookup in this file keys on `(projectId, githubRepoId)` or on
 * > the primary key `id` — never on `githubRepoId` alone.**
 *
 * A `findFirst({ where: { githubRepoId } })` added later would compile, pass its own
 * test, and quietly return *another tenant's* row. The standalone
 * `@@index([githubRepoId])` in the schema is not a licence to do that: it exists for
 * Phase 06's webhook fan-out, which must find **all** matching repositories across
 * projects to route one incoming event. That is the single legitimate
 * `githubRepoId`-only query in the system, and it does not exist yet.
 *
 * The other invariant, matching `project.repository.ts`: **every query is scoped by
 * its owner in the `where`**, never filtered afterwards in the service. The one
 * exception is `findOwnershipById`, which is the function that *establishes* the
 * scope; see its own doc comment.
 */

/** Columns that make up a `RepositoryRecord`. Declared once so every read returns the
 * same shape and no query accidentally over-selects (mirrors `PROJECT_SELECT`). */
const REPOSITORY_SELECT = {
  id: true,
  projectId: true,
  installationId: true,
  githubRepoId: true,
  owner: true,
  name: true,
  fullName: true,
  defaultBranch: true,
  isPrivate: true,
  htmlUrl: true,
  sizeBytes: true,
  connectionStatus: true,
  indexStatus: true,
  indexedCommitSha: true,
  indexVersion: true,
  indexedFileCount: true,
  skippedFileCount: true,
  lastIndexedAt: true,
  // Phase 03: the worker's own repository.repository.ts (apps/worker) is the first
  // writer of this column. Surfaced here so getIndexStatus can fall back to it when no
  // IndexJob row exists yet, and so RepositoryDto can show a specific failure reason.
  indexError: true,
  settings: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** phase-02 §11: `ACTIVE → DISCONNECTED` on delete. A disconnected repository is
 * excluded from every active listing, but the row survives so reconnect history and a
 * completed index are not destroyed. */
const DISCONNECTED = "DISCONNECTED";
const ACTIVE = "ACTIVE";
const ACCESS_LOST = "ACCESS_LOST";

/**
 * The **one deliberately owner-unscoped read in this module**, and the only query
 * `requireTenantAccess` makes for a `repositoryId`.
 *
 * It resolves the whole ownership chain — `Repository → Project → userId` — in a
 * **single query** (plan.md §34.2) using a nested `select`, not two round trips.
 *
 * Unscoped for exactly the reason `project.repository.findOwnershipById` is: a
 * `where: { id, project: { userId } }` lookup can only answer yes or no, which makes
 * "this repository is not yours" and "this repository does not exist"
 * indistinguishable *in the logs* — and §20 requires the warn line on a failed tenancy
 * check to say which. The caller-visible answer is 404 either way, so nothing leaks:
 * the row never leaves the tenancy check, only the four columns it decides from.
 */
export async function findOwnershipById(
  repositoryId: string,
): Promise<RepositoryOwnership | null> {
  const row = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: {
      id: true,
      projectId: true,
      project: { select: { userId: true, deletedAt: true } },
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.project.userId,
    projectDeletedAt: row.project.deletedAt,
  };
}

/** Project-scoped detail read. Keyed on the primary key **and** `projectId`, so a
 * repository id belonging to another project cannot be read through a project the
 * caller does own. */
export async function findByIdForProject(
  projectId: string,
  repositoryId: string,
): Promise<RepositoryRecord | null> {
  return prisma.repository.findFirst({
    where: { id: repositoryId, projectId },
    select: REPOSITORY_SELECT,
  });
}

/**
 * The project's **active** repositories — `DISCONNECTED` rows are excluded, which is
 * what makes §14's "disconnect, then confirm it no longer appears in the active list"
 * true. `ACCESS_LOST` rows are deliberately *included*: they are still connected and
 * still the user's, they just cannot be reached right now, and hiding them would
 * remove the only place the user could see the problem.
 */
export async function listByProject(
  projectId: string,
): Promise<RepositoryRecord[]> {
  return prisma.repository.findMany({
    where: { projectId, connectionStatus: { not: DISCONNECTED } },
    select: REPOSITORY_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

/**
 * The 409 pre-check. **Keyed on the composite `(projectId, githubRepoId)`** — see this
 * file's header. Includes `DISCONNECTED` rows, because the unique constraint does too:
 * a soft-disconnected row still occupies the pair, so a probe that ignored it would
 * propose an insert the database then rejects.
 */
export async function findByProjectAndGithubRepoId(
  projectId: string,
  githubRepoId: bigint,
): Promise<RepositoryRecord | null> {
  return prisma.repository.findUnique({
    where: { projectId_githubRepoId: { projectId, githubRepoId } },
    select: REPOSITORY_SELECT,
  });
}

export interface CreateRepositoryInput {
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
}

export type CreateRepositoryResult =
  | { ok: true; repository: RepositoryRecord }
  | { ok: false; reason: "ALREADY_CONNECTED" };

/** Prisma signals a unique-constraint violation with `code: "P2002"`. Duck-typed
 * rather than `instanceof PrismaClientKnownRequestError` so the check works across
 * Prisma's driver-adapter client without importing an error class from the generated
 * client (Rule B keeps that import inside packages/db). Identical to
 * `project.repository.ts`'s helper, deliberately — a shared "prisma-errors.ts" would
 * be a third file both repositories import for six lines. */
function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * Inserts a repository in `indexStatus: PENDING` / `connectionStatus: ACTIVE`.
 *
 * A `(projectId, githubRepoId)` collision is a **domain outcome, not an exception**:
 * the service answers it with a 409, and that policy is business logic which should
 * not have to know what a Prisma error code looks like. Every other failure still
 * throws.
 *
 * This is the *real* guard behind the service's pre-check. The pre-check races under
 * concurrency — two simultaneous connects of the same repository both see "not
 * connected" — and only the unique constraint actually holds. Same "pre-check plus
 * constraint" pattern as `project.service.createProject`'s slug handling.
 *
 * `indexStatus` and `connectionStatus` are left to the schema defaults rather than
 * written here: phase-02 §11 says PENDING is the only status this phase can produce,
 * and passing them explicitly would make it look like a choice a caller could vary.
 */
export async function create(
  input: CreateRepositoryInput,
): Promise<CreateRepositoryResult> {
  try {
    const repository = await prisma.repository.create({
      data: {
        projectId: input.projectId,
        installationId: input.installationId,
        githubRepoId: input.githubRepoId,
        owner: input.owner,
        name: input.name,
        fullName: input.fullName,
        defaultBranch: input.defaultBranch,
        isPrivate: input.isPrivate,
        htmlUrl: input.htmlUrl,
        sizeBytes: input.sizeBytes,
      },
      select: REPOSITORY_SELECT,
    });
    return { ok: true, repository };
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      return { ok: false, reason: "ALREADY_CONNECTED" };
    }
    throw err;
  }
}

/**
 * `ACTIVE → DISCONNECTED` (phase-02 §11). Returns the number of rows actually
 * transitioned, which is `0` when the repository was already disconnected.
 *
 * That distinction is what makes `DELETE /api/repositories/:id` idempotent *and* still
 * able to log the difference, exactly as `softDeleteForUser` does for projects: the
 * `connectionStatus: { not: DISCONNECTED }` in the `where` means a repeat delete never
 * overwrites the original transition.
 *
 * Keyed on the primary key plus `projectId` — the tenancy check has already proved the
 * caller owns this project, and re-asserting it in the `where` closes the window where
 * the two disagree.
 */
export async function markDisconnected(
  projectId: string,
  repositoryId: string,
): Promise<number> {
  const result = await prisma.repository.updateMany({
    where: {
      id: repositoryId,
      projectId,
      connectionStatus: { not: DISCONNECTED },
    },
    data: { connectionStatus: DISCONNECTED },
  });
  return result.count;
}

/**
 * `ACTIVE → ACCESS_LOST` (phase-02 §11): the installation token mint came back 401, so
 * the App can no longer reach this repository.
 *
 * **Reachable but not fully exercised until Phase 03.** Nothing in this phase runs
 * long enough to observe an installation being revoked mid-flight — a connect attempt
 * against a revoked installation simply fails and no row is created (§12 says so
 * explicitly: "for a brand-new connect attempt, simply reject"). It is built now
 * because the transition is a property of the GitHub client this phase owns, and
 * because Phase 03's background indexing is the first thing that can *be* running when
 * access disappears.
 *
 * Only `ACTIVE` rows transition: a `DISCONNECTED` repository the user already
 * disconnected must not be resurrected into `ACCESS_LOST` by a background job.
 */
export async function markAccessLost(
  projectId: string,
  repositoryId: string,
): Promise<number> {
  const result = await prisma.repository.updateMany({
    where: { id: repositoryId, projectId, connectionStatus: ACTIVE },
    data: { connectionStatus: ACCESS_LOST },
  });
  return result.count;
}
