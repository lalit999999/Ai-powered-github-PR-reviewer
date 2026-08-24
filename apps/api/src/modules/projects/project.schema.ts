import { z } from "zod";

/**
 * Every projects route parses its input through these, via `parseOrThrow`
 * (src/lib/validation.ts) — no handler touches `req.body`/`req.query`/`req.params`
 * directly (Architecture Rules, phase-00 §7).
 */

/** Bounded per phase-01 §7: `limit <= 50`. */
export const PROJECT_LIST_MAX_LIMIT = 50;
export const PROJECT_LIST_DEFAULT_LIMIT = 20;

/** phase-01 §7: name non-empty, <= 100 chars. */
export const PROJECT_NAME_MAX_LENGTH = 100;

export const createProjectBodySchema = z.object({
  // `.trim()` first so "   " is rejected as empty rather than stored as whitespace —
  // and so the stored name matches the one the slug is derived from.
  name: z
    .string()
    .trim()
    .min(1, "Project name is required")
    .max(PROJECT_NAME_MAX_LENGTH, `Project name must be at most ${PROJECT_NAME_MAX_LENGTH} characters`),
});

export const listProjectsQuerySchema = z.object({
  // Opaque to the client: currently a project id (see project.repository.listByUser).
  cursor: z.string().min(1).optional(),
  // `z.coerce` because Express query values are always strings. `.default()` runs
  // before coercion, so an absent `limit` yields the default rather than NaN.
  limit: z.coerce
    .number()
    .int("limit must be a whole number")
    .positive("limit must be greater than 0")
    .max(PROJECT_LIST_MAX_LIMIT, `limit must be at most ${PROJECT_LIST_MAX_LIMIT}`)
    .default(PROJECT_LIST_DEFAULT_LIMIT),
});

/**
 * Route params. Only "non-empty string" is asserted, deliberately: `Project.id` is a
 * `TEXT` column, so a malformed id is simply a value that matches no row, and letting
 * it fall through to `requireTenantAccess` renders it as 404 like every other
 * unresolvable project. Validating it as a UUID here would answer "that id could not
 * possibly exist" — a shape oracle that a 404-for-everything policy (§12) otherwise
 * denies the caller.
 */
export const projectIdParamSchema = z.object({
  projectId: z.string().min(1),
});

export type CreateProjectInput = z.infer<typeof createProjectBodySchema>;
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
export type ProjectIdParam = z.infer<typeof projectIdParamSchema>;
