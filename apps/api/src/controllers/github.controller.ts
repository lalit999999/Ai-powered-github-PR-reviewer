import type { Request, Response } from "express";
import { requireSession } from "../lib/auth/session.js";
import { parseOrThrow } from "../lib/validation.js";
import {
  installationIdParamSchema,
  listInstallationReposQuerySchema,
} from "../modules/repositories/repository.schema.js";
import * as repositoryService from "../modules/repositories/repository.service.js";

/**
 * The two GitHub installation routes (phase-02 §7). Same four steps as every other
 * controller in this codebase — **authenticate → resolve tenancy → validate → delegate**
 * — then return the envelope. No business logic, no ownership check of its own, no raw
 * input parsing (plan.md §28).
 *
 * These two routes have no *resource* tenancy to resolve — an installation is not under
 * a project — so the ownership check lives one layer down, in
 * `repository.service.requireInstallationOwnership`, which is the same rule
 * `requireTenantAccess` embodies applied to a resource that is not part of the project
 * chain. The controller still never performs it.
 *
 * ## Why a 403 here is correct, when everywhere else it would be a leak
 *
 * `requireTenantAccess` answers **404** for a foreign project or repository, and that is
 * deliberate: a project id is an opaque uuid, so a 403 would confirm "this id names a
 * real resource" and turn guessing into enumeration (phase-01-log §16).
 *
 * An installation id is a different kind of value, and the difference is what makes the
 * exception safe rather than inconsistent:
 *
 * - It is a **GitHub-global integer the user can already read on github.com** — it is in
 *   the URL of their own installation settings page, and in the install-flow redirect.
 *   Confirming that an id names an installation tells an attacker nothing they could not
 *   get from GitHub directly.
 * - It is **not this system's identifier**. There is no per-tenant id space to
 *   enumerate; the ids exist whether or not this product ever saw them.
 * - phase-02 §7 specifies `403 (installation not owned by caller)` outright, and unlike
 *   the repository-route 403 (which §7 also lists, and which *is* refused — see
 *   `tenant-access.ts`), there is no security argument on the other side.
 *
 * What is still protected is the *contents*: the repository listing is only ever made
 * for an installation the caller owns, so no private repository name leaks. That check
 * is server-side and never trusts client input (§13).
 *
 * This asymmetry is recorded in docs/decisions/phase-02-log.md so it does not later read
 * as an oversight and get "fixed" in either direction.
 */

/**
 * GET /api/github/installations — the caller's own installations.
 *
 * Syncs from `GET /user/installations` first, rather than returning only what is
 * already stored: until Phase 06's webhooks exist, a page load *is* the sync (§10). A
 * user who just completed the install flow would otherwise see an empty list and
 * conclude it failed.
 */
export async function listInstallations(req: Request, res: Response): Promise<void> {
  const session = await requireSession(req);

  const installations = await repositoryService.syncInstallations({ userId: session.user.id });

  res.status(200).json({ installations });
}

/**
 * GET /api/github/installations/:installationId/repos — the connect picker's source.
 * 403 if the installation is not the caller's (see this file's header); 401 without a
 * session.
 */
export async function listInstallationRepos(req: Request, res: Response): Promise<void> {
  const session = await requireSession(req);
  const { installationId } = parseOrThrow(installationIdParamSchema, req.params);
  const query = parseOrThrow(listInstallationReposQuerySchema, req.query);

  const repos = await repositoryService.listInstallationRepositories(
    { userId: session.user.id },
    installationId,
    query,
  );

  res.status(200).json({ repos });
}
