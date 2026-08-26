import { prisma } from "@repo/db";
import type { RepositoryOwnership, RepositoryRecord } from "./repository.types.js";

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
 * projects to route one incoming event.
 *
 * That fan-out is now three functions, all deliberately `githubRepoId`-only and all
 * living at the bottom of this file, grouped under their own header:
 * `findConnectedByGithubRepoId` (the read that resolves one delivery to every tenant it
 * affects), `markAccessLostByGithubRepoId`, and `renameByGithubRepoId` (the two writes a
 * `repository` webhook event drives — GitHub's own copy of a repository is one thing
 * shared by every project connected to it, so an "archived"/"deleted" or "renamed"
 * notification about it is correctly applied to all of them at once). **Every other
 * lookup or mutation in this file keys on `(projectId, githubRepoId)` or on the primary
 * key `id`.** The rule is not weakened by Phase 06; it is given its three documented
 * exceptions, and a fourth should not be added without adding a fourth line here.
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
export async function findOwnershipById(repositoryId: string): Promise<RepositoryOwnership | null> {
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
export async function findByIdForProject(projectId: string, repositoryId: string): Promise<RepositoryRecord | null> {
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
export async function listByProject(projectId: string): Promise<RepositoryRecord[]> {
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
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "P2002";
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
export async function create(input: CreateRepositoryInput): Promise<CreateRepositoryResult> {
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
export async function markDisconnected(projectId: string, repositoryId: string): Promise<number> {
  const result = await prisma.repository.updateMany({
    where: { id: repositoryId, projectId, connectionStatus: { not: DISCONNECTED } },
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
export async function markAccessLost(projectId: string, repositoryId: string): Promise<number> {
  const result = await prisma.repository.updateMany({
    where: { id: repositoryId, projectId, connectionStatus: ACTIVE },
    data: { connectionStatus: ACCESS_LOST },
  });
  return result.count;
}

// ---------------------------------------------------------------------------
// Phase 06 — webhook tenant fan-out and installation/repository-scoped transitions.
// See this file's header comment for why the three `githubRepoId`-only functions below
// are the system's only sanctioned exceptions to the (projectId, githubRepoId) rule.
// ---------------------------------------------------------------------------

/** One tenant's view of an incoming webhook delivery — everything `event-router.ts`
 * needs to decide that tenant's outcome, resolved in the same query that found it. */
export interface WebhookTenantTarget {
  repositoryId: string;
  projectId: string;
  installationId: bigint;
  fullName: string;
  /** Raw `Project.settings` JSON, parsed by the caller via `@repo/shared`'s
   * `parseProjectReviewSettings` — passed through unparsed for the same reason
   * `findOwnershipById` passes through raw columns: this file has no opinion on the
   * shape, only on which rows qualify. */
  projectSettings: unknown;
  /** Always `null` on a returned row — the query below excludes soft-deleted projects
   * via the join, so this can never be non-null in practice. Kept on the type anyway,
   * rather than dropped, so the exclusion is a checkable invariant (an integration test
   * can assert every returned row has `projectDeletedAt === null`) instead of a fact
   * that only lives in this comment. */
  projectDeletedAt: Date | null;
}

/**
 * Every repository connected to this GitHub repository, across **all** projects — the
 * one read this file's header names as the fan-out's legitimate `githubRepoId`-only
 * query (plan.md §45, §34.3: "the same GitHub repository connected to two different
 * projects must produce two fully independent events from one delivery").
 *
 * **Excludes `DISCONNECTED` repositories** — a user who disconnected a repository must
 * not keep getting reviews for it, the same rule `listByProject` already enforces for
 * the UI.
 *
 * **Includes `ACCESS_LOST` repositories, deliberately.** The alternative — excluding
 * them, on the theory that a lost-access repository can't be reviewed anyway — was
 * considered and rejected: a `pull_request` webhook delivery *arriving* for a
 * repository is itself evidence GitHub still has this App's webhook wired up for it,
 * which means the `ACCESS_LOST` status is more likely stale than the delivery is wrong.
 * Excluding it would silently drop reviews for a repository that has actually recovered
 * until Prompt 4's installation sync happens to catch up — a silent, unbounded gap with
 * no user-facing signal, since this fan-out has no HTTP response to carry one. Including
 * it costs nothing worse than Phase 07's own install-token mint failing and logging an
 * error it already has to handle for other reasons. Matches `listByProject`'s "still
 * connected, still the user's" reasoning for the identical status.
 *
 * **Excludes repositories whose parent project is soft-deleted**, resolved through the
 * `project` relation in this same query via `project: { deletedAt: null }` — one round
 * trip, not a per-tenant follow-up read, matching `findOwnershipById`'s single-query
 * discipline.
 *
 * Returns `Project.settings` raw rather than requiring a second query per tenant: the
 * draft-PR gate (`event-router.ts`) needs it for every tenant in the fan-out, and a
 * per-tenant round trip inside this latency-sensitive path would be wasted work for
 * data already sitting on the row this query already joined to.
 */
export async function findConnectedByGithubRepoId(githubRepoId: bigint): Promise<WebhookTenantTarget[]> {
  const rows = await prisma.repository.findMany({
    where: {
      githubRepoId,
      connectionStatus: { not: DISCONNECTED },
      project: { deletedAt: null },
    },
    select: {
      id: true,
      projectId: true,
      installationId: true,
      fullName: true,
      project: { select: { settings: true, deletedAt: true } },
    },
  });

  return rows.map((row) => ({
    repositoryId: row.id,
    projectId: row.projectId,
    installationId: row.installationId,
    fullName: row.fullName,
    projectSettings: row.project.settings,
    projectDeletedAt: row.project.deletedAt,
  }));
}

/**
 * `ACTIVE → ACCESS_LOST` for every repository under an installation (an `installation`
 * webhook's `suspend`/`deleted` actions — Prompt 4). Phase 02's `markAccessLost` is
 * project-scoped and cannot express "every repository this installation touches,
 * regardless of which project"; this is that missing installation-wide transition.
 *
 * **Only `ACTIVE` rows transition** — following `markAccessLost`'s own `connectionStatus:
 * ACTIVE` guard exactly: a `DISCONNECTED` repository the user already disconnected must
 * never be resurrected into `ACCESS_LOST` by a background webhook.
 */
export async function markAccessLostByInstallation(installationId: bigint): Promise<number> {
  const result = await prisma.repository.updateMany({
    where: { installationId, connectionStatus: ACTIVE },
    data: { connectionStatus: ACCESS_LOST },
  });
  return result.count;
}

/**
 * `ACCESS_LOST → ACTIVE` for every repository under an installation (an `installation`
 * webhook's `unsuspend`/re-`created` actions — Prompt 4).
 *
 * **Only `ACCESS_LOST` rows transition** — the mirror image of `markAccessLostByInstallation`'s
 * guard. An `ACTIVE` row has nothing to restore, and — the case that actually matters —
 * a `DISCONNECTED` row must never be swept back into `ACTIVE` just because its
 * installation came back; the user's explicit disconnect has to survive an installation
 * lifecycle event it had nothing to do with.
 */
export async function restoreActiveByInstallation(installationId: bigint): Promise<number> {
  const result = await prisma.repository.updateMany({
    where: { installationId, connectionStatus: ACCESS_LOST },
    data: { connectionStatus: ACTIVE },
  });
  return result.count;
}

/**
 * `ACTIVE → ACCESS_LOST` for every repository row sharing this `githubRepoId`, across
 * every project — a `repository` webhook's `archived`/`deleted` actions (Prompt 4): the
 * underlying GitHub repository itself became unusable, which is true for every project
 * connected to it, not just one. The second of this file's `githubRepoId`-only
 * exceptions (see the header comment); **only `ACTIVE` rows transition**, for the same
 * reason `markAccessLostByInstallation` restricts itself.
 */
export async function markAccessLostByGithubRepoId(githubRepoId: bigint): Promise<number> {
  const result = await prisma.repository.updateMany({
    where: { githubRepoId, connectionStatus: ACTIVE },
    data: { connectionStatus: ACCESS_LOST },
  });
  return result.count;
}

/**
 * Renames every repository row sharing this `githubRepoId` — a `repository` webhook's
 * `renamed` action (Prompt 4). The third of this file's `githubRepoId`-only exceptions.
 *
 * **Deliberately not filtered by `connectionStatus`.** Unlike the two `markAccessLost*`
 * functions above, a rename does not resurrect anything — it does not touch
 * `connectionStatus` at all — so there is no "a disconnected repository must not be
 * reactivated" hazard here to guard against. A `DISCONNECTED` row keeping an accurate
 * `fullName`/`htmlUrl` is the same choice already made for every other descriptive
 * column on a disconnected row (the row survives a disconnect specifically so its
 * history stays legible; a stale name after a rename would undermine that).
 */
export async function renameByGithubRepoId(
  githubRepoId: bigint,
  next: { owner: string; name: string; fullName: string; htmlUrl: string },
): Promise<number> {
  const result = await prisma.repository.updateMany({
    where: { githubRepoId },
    data: { owner: next.owner, name: next.name, fullName: next.fullName, htmlUrl: next.htmlUrl },
  });
  return result.count;
}
