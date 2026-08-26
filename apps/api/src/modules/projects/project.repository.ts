import { prisma } from "@repo/db";
import type { ProjectOwnership, ProjectRecord } from "./project.types.js";

/**
 * Prisma queries only — no business logic, no logging, no error translation beyond
 * turning Prisma's own constraint-violation shape into a domain-level result (see
 * `create` below). Only files matching `*.repository.ts` (and `packages/db/**`) may
 * import `@repo/db`'s Prisma-backed exports (Rule B, phase-00 §3,
 * docs/decisions/phase-00-log.md §2).
 *
 * Two invariants hold across every function here:
 *
 * - **Every query is scoped by `userId`** — the owner scope is in the `where`, never
 *   applied afterwards in the service. The single exception is
 *   `findOwnershipById`, which is the function that *establishes* the scope; see its
 *   own doc comment.
 * - **Every read excludes soft-deleted rows** unless the caller explicitly asks
 *   otherwise, which only `findSlugsForUserByPrefix` does (and says why).
 */

/** Columns that make up a `ProjectRecord`. Declared once so every read returns the
 * same shape and no query accidentally over-selects. */
const PROJECT_SELECT = {
  id: true,
  userId: true,
  name: true,
  slug: true,
  settings: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The **one deliberately owner-unscoped read in this module**, and the only query
 * `requireTenantAccess` makes.
 *
 * It has to be unscoped: a `where: { id, userId }` lookup can only answer "yes or no",
 * which would make "this project is not yours" and "this project does not exist"
 * indistinguishable *in the logs* — and phase-01 §20 requires the warn line on a
 * failed tenancy check to say which. The caller-visible answer is 404 either way
 * (§12), so nothing leaks: the row itself never leaves the tenancy check, only the
 * three columns it decides from.
 *
 * This is one query resolving the whole ownership chain, per plan.md §34.2. Phase 02
 * extends the chain (repository → project → user) by adding a sibling function here,
 * not by widening this one.
 */
export async function findOwnershipById(projectId: string): Promise<ProjectOwnership | null> {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true, deletedAt: true },
  });
}

/** Owner-scoped detail read. Excludes soft-deleted rows — a soft-deleted project is
 * not found, per phase-01 §7/§11. */
export async function findByIdForUser(userId: string, projectId: string): Promise<ProjectRecord | null> {
  return prisma.project.findFirst({
    where: { id: projectId, userId, deletedAt: null },
    select: PROJECT_SELECT,
  });
}

export interface ListByUserOptions {
  limit: number;
  cursor?: string | undefined;
}

/**
 * One page of the caller's own non-deleted projects, newest first.
 *
 * The `where` is exactly the `@@index([userId, deletedAt])` from phase-01 §6 — that
 * index exists for this query. `id` is appended to the sort so the order is total
 * (two projects created in the same millisecond would otherwise paginate
 * unpredictably), and is what the opaque cursor carries.
 *
 * Takes `limit + 1` rows: the extra row is how the service knows whether a next page
 * exists without a second `count` query.
 */
export async function listByUser(userId: string, options: ListByUserOptions): Promise<ProjectRecord[]> {
  return prisma.project.findMany({
    where: { userId, deletedAt: null },
    select: PROJECT_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });
}

/**
 * Slugs already claimed by this user that start with `prefix`.
 *
 * **Explicitly includes soft-deleted rows** — the deliberate exception to the
 * exclude-deleted rule, and the reason it is stated in the function name's own doc
 * rather than hidden in an options flag. The `@@unique([userId, slug])` constraint has
 * no `deletedAt` in it, so a soft-deleted project still owns its slug; a uniqueness
 * probe that ignored deleted rows would propose a slug the database then rejects.
 */
export async function findSlugsForUserByPrefix(userId: string, prefix: string): Promise<string[]> {
  const rows: { slug: string }[] = await prisma.project.findMany({
    where: { userId, slug: { startsWith: prefix } },
    select: { slug: true },
  });
  return rows.map((row) => row.slug);
}

export type CreateProjectResult = { ok: true; project: ProjectRecord } | { ok: false; reason: "SLUG_TAKEN" };

/** Prisma signals a unique-constraint violation with `code: "P2002"`. Duck-typed
 * rather than `instanceof PrismaClientKnownRequestError` so the check works across
 * Prisma's driver-adapter client without importing an error class from the generated
 * client (Rule B keeps that import inside packages/db). */
function isUniqueConstraintViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "P2002";
}

/**
 * Inserts a project. A `(userId, slug)` collision is a **domain outcome, not an
 * exception** — the service's retry-once-then-409 policy (phase-01 §12) is business
 * logic, and it should not have to know what a Prisma error code looks like. Every
 * other failure still throws.
 */
export async function create(
  userId: string,
  input: { name: string; slug: string }
): Promise<CreateProjectResult> {
  try {
    const project = await prisma.project.create({
      data: { userId, name: input.name, slug: input.slug },
      select: PROJECT_SELECT,
    });
    return { ok: true, project };
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      return { ok: false, reason: "SLUG_TAKEN" };
    }
    throw err;
  }
}

/**
 * Soft-delete (phase-01 §11 — there is no hard delete in this phase). Returns the
 * number of rows actually transitioned, which is `0` when the project was already
 * soft-deleted. That distinction is what makes the route idempotent *and* still able
 * to log the difference: `deletedAt: null` in the `where` means a repeat delete never
 * overwrites the original deletion timestamp.
 */
export async function softDeleteForUser(userId: string, projectId: string): Promise<number> {
  const result = await prisma.project.updateMany({
    where: { id: projectId, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return result.count;
}
