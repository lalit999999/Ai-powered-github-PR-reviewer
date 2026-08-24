import type { BranchProbeResult, GithubRepositoryMetadata, GithubResult } from "@repo/github";
import {
  ConflictError,
  ForbiddenError,
  ServiceUnavailableError,
  UnprocessableEntityError,
  ValidationError,
} from "../../lib/errors.js";
import { createLogger } from "@repo/observability";
import { GITHUB_REPO_URL_MESSAGE, parseGithubRepoUrl, type GithubRepoRef } from "./repository.schema.js";
import type { RepositoryRecord } from "./repository.types.js";

/**
 * The six-step connect-validation chain from phase-02 §3, short-circuiting on the first
 * failure.
 *
 * **Every failure has its own error class, code, and message.** §4 is emphatic that a
 * generic "connection failed" is not acceptable, and §15 makes "four distinct errors
 * for four invalid cases" an acceptance criterion — so this is a correctness
 * requirement, not a UX nicety:
 *
 * | # | Check | Failure |
 * |---|---|---|
 * | 1 | The URL parses under the allow-list (only when a URL was given) | `400 VALIDATION_ERROR` |
 * | 2 | The installation can reach the repository | `403 FORBIDDEN` |
 * | 3 | Not already connected **to this project** | `409 CONFLICT` |
 * | 4 | The repository has commits | `422 UNPROCESSABLE_ENTITY` |
 * | 5 | Under the size cap | `422 UNPROCESSABLE_ENTITY` |
 * | 6 | The default branch is resolvable | `422 UNPROCESSABLE_ENTITY`, own message |
 *
 * ## Two structural rules this file is built around
 *
 * **§21's cost lever is enforced by the type signature.** `GET /repos/{o}/{r}` is
 * called **once per connect attempt**, and this service receives the already-fetched
 * {@link GithubRepositoryMetadata}. It cannot fetch one — it imports no Octokit, no
 * factory, and no fetching function — so "re-fetch per sub-check" is not a mistake
 * that can be made here, rather than one that must be remembered not to make.
 *
 * **Access is verified through the installation, never through the submitted URL**
 * (§13). Even on the `repoUrl` path, the URL only supplies `{owner, repo}` to address
 * an installation-scoped API call; nothing is trusted because the user typed it, and
 * the *response* to that call is what gets stored.
 *
 * Rule B: no Prisma here. Step 3's pre-check row is passed in by `repository.service`.
 */

const logger = createLogger("repository.validation");

// ---------------------------------------------------------------------------
// The size cap
// ---------------------------------------------------------------------------

/**
 * The connect-time repository size cap, **in KiB**, because that is the unit GitHub
 * reports and converting at the comparison is how unit bugs happen. A bare `500000` in
 * an `if` is a landmine; this constant's name and this comment are the defusing.
 *
 * `plan.md` A7 states the limit as "~25k source files / ~500 MB checkout". 500 MiB is
 * taken as the number.
 *
 * **Two honest caveats, both recorded in docs/decisions/phase-02-log.md:**
 *
 * 1. **GitHub's `size` is the *git* size, not a checkout size.** This was verified
 *    empirically against live `api.github.com` rather than assumed:
 *    `GET /repos/torvalds/linux` reports `size: 6350863`, which is ~6.06 GiB — the size
 *    of that project's packed git objects. It is inconsistent with bytes (6.3 MB) and
 *    with MB (6.3 TB), so the unit is settled: **KiB**. A repository's git size is
 *    normally *larger* than its checkout, because history is included, so capping the
 *    git size at 500 MiB is **conservative** against A7's "checkout" wording: it
 *    rejects some repositories whose working tree would fit. That is the deliberate
 *    direction to err in for an MVP — accepting a repository the indexer then chokes on
 *    is a worse failure than declining one at the door with a clear message.
 * 2. **A7's file-count half (~25k files) is not checkable from this metadata call at
 *    all.** `GET /repos` reports no file count. Phase 03, which walks the tree, is the
 *    first code that can enforce it. Nothing here pretends to.
 */
export const REPOSITORY_SIZE_CAP_KIB = 500 * 1024;

/** For messages. Uses the same 1024 base as the cap above, so the number a user is
 * told matches the number that was compared. */
function kibToMib(kib: number): number {
  return Math.round((kib / 1024) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Step 1 — the URL
// ---------------------------------------------------------------------------

/**
 * Step 1. Turns a user-supplied URL into the `{owner, repo}` pair that addresses the
 * installation-scoped API call.
 *
 * `connectRepositoryBodySchema` already rejects a bad URL at the HTTP boundary with the
 * same message and the same parser, so over HTTP this cannot fail. It is still checked
 * here, and that is not redundancy for its own sake: this service is callable from
 * anywhere (a future CLI, a Phase 06 webhook path, a background reconcile), and a
 * validation chain whose first step is "assume someone else did step 1" is not a
 * validation chain.
 *
 * The parser itself is `repository.schema.ts`'s — §13 requires it be *reused, never
 * reimplemented*, and re-parsing here with anything else is exactly the bug that
 * requirement exists to prevent.
 */
export function resolveRepoRefFromUrl(repoUrl: string): GithubRepoRef {
  const parsed = parseGithubRepoUrl(repoUrl);

  if (!parsed.ok) {
    logger.warn("repository connect rejected: unparseable url", { reason: parsed.reason });
    throw new ValidationError(GITHUB_REPO_URL_MESSAGE, {
      details: { fieldErrors: { repoUrl: [GITHUB_REPO_URL_MESSAGE] } },
    });
  }

  return { owner: parsed.owner, repo: parsed.repo };
}

// ---------------------------------------------------------------------------
// Step 2 — access
// ---------------------------------------------------------------------------

/** phase-02 §12's exact wording. */
export const NO_ACCESS_MESSAGE =
  "The GitHub App doesn't have access to this repository — check your installation settings";

/**
 * Step 2. Unwraps the result of the single `GET /repos/{o}/{r}` into metadata, or into
 * the one distinct error each failure deserves.
 *
 * **`NOT_ACCESSIBLE` becomes a 403, and that is a deliberate exception to this repo's
 * 404-everywhere policy.** `requireTenantAccess` answers 404 for a foreign or
 * nonexistent *project or repository row*, because a 403 there would let an attacker
 * enumerate other tenants' uuids. Nothing like that is true here: the caller has
 * already proved they own this project, and they named this repository themselves — by
 * typing its URL or picking it out of their own installation's list. Telling them "the
 * App can't reach it" reveals nothing they did not supply, and it is the only
 * actionable answer, which is precisely what `ForbiddenError`'s doc comment in
 * `errors.ts` reserved it for.
 *
 * GitHub answers `404`, not `403`, for a repository the installation cannot see — an
 * anti-enumeration measure on their side that makes "does not exist" and "you cannot
 * see it" indistinguishable on the wire. Both collapse into `NOT_ACCESSIBLE` upstream,
 * and both get this message, because it is the correct advice either way: check the
 * installation.
 *
 * `UNAVAILABLE` is a 503, never a 403 — telling a user to reconfigure a working
 * installation because GitHub had a bad minute sends them to fix something that is not
 * broken (§12/§14).
 */
export function assertRepositoryAccessible(
  result: GithubResult<{ repository: GithubRepositoryMetadata }>,
  context: { projectId: string; userId: string; target: string },
): GithubRepositoryMetadata {
  if (result.ok) return result.repository;

  if (result.reason === "NOT_ACCESSIBLE") {
    logger.warn("repository connect rejected: installation has no access", {
      projectId: context.projectId,
      userId: context.userId,
      target: context.target,
    });
    throw new ForbiddenError(NO_ACCESS_MESSAGE, { details: { repository: context.target } });
  }

  logger.warn("repository connect failed: github unavailable", {
    projectId: context.projectId,
    userId: context.userId,
    target: context.target,
    reason: result.reason,
  });
  throw new ServiceUnavailableError("GitHub is temporarily unavailable, try again");
}

// ---------------------------------------------------------------------------
// Step 3 — already connected
// ---------------------------------------------------------------------------

/**
 * Step 3. **The dual-project case is not a conflict.**
 *
 * phase-02 §4 requires that the same GitHub repository can be connected to two
 * *different* projects and that both connections work independently, and §15 makes it
 * an acceptance criterion. `plan.md` §45 names "assuming `githubRepoId` is globally
 * unique" as a Phase 2 failure mode.
 *
 * That is why this function takes the row the caller already looked up **keyed on
 * `(projectId, githubRepoId)`** rather than looking anything up itself — there is no
 * seam here through which a global uniqueness check could be "helpfully" added.
 *
 * **This pre-check is not the guard.** It races: two simultaneous connects of the same
 * repository both see `null` and both proceed. The `@@unique([projectId,
 * githubRepoId])` constraint is what actually holds, and `repository.repository.create`
 * translates its `P2002` into the same 409. Pre-check *and* constraint — the same
 * belt-and-braces pattern `project.service.createProject` uses for slugs. The pre-check
 * earns its place by producing the good error without a wasted insert in the common
 * case.
 */
export function assertNotAlreadyConnected(
  existing: RepositoryRecord | null,
  context: { projectId: string; userId: string; githubRepoId: bigint },
): void {
  if (!existing) return;

  logger.warn("repository connect rejected: already connected to this project", {
    projectId: context.projectId,
    userId: context.userId,
    githubRepoId: context.githubRepoId.toString(),
    repositoryId: existing.id,
    connectionStatus: existing.connectionStatus,
  });

  throw new ConflictError("That repository is already connected to this project", {
    details: { repositoryId: existing.id, connectionStatus: existing.connectionStatus },
  });
}

// ---------------------------------------------------------------------------
// Steps 4–6 — the metadata checks
// ---------------------------------------------------------------------------

export const EMPTY_REPOSITORY_MESSAGE = "That repository is empty — push at least one commit before connecting it";
export const DEFAULT_BRANCH_MESSAGE = "The repository's default branch could not be resolved";

/** Supplied by `repository.service`; invoked **only** in the ambiguous `size === 0`
 * case, so an ordinary connect never pays for it (§21). */
export type BranchProbe = () => Promise<BranchProbeResult>;

export interface RepositoryUsabilityContext {
  projectId: string;
  userId: string;
  probeDefaultBranch: BranchProbe;
}

/**
 * Steps 4, 5 and 6, in order, against the **one** metadata object fetched for this
 * connect attempt.
 *
 * ### Step 4 — emptiness, from combined signals
 *
 * `size: 0` is the documented signal and it is **not reliable on its own**: GitHub
 * computes repository size asynchronously, so a repository pushed moments ago can
 * report `0` while holding real commits. Rejecting on it alone would tell a user who
 * just created and pushed a repository that it is empty, which is both wrong and
 * exactly the "do not reject a legitimate small repo" failure. So the signals are
 * combined:
 *
 * - `sizeKib > 0` → has content. Done, no probe, no extra call.
 * - `sizeKib === 0` **and** no default branch at all → unambiguously empty.
 * - `sizeKib === 0` **but** a default branch is named → ambiguous, and only here does
 *   the probe run: `GET /repos/{o}/{r}/branches/{default}` answers whether that branch
 *   actually has commits. A `404` on the ref (from a repository whose metadata we just
 *   read successfully) means empty.
 * - The probe returning `UNKNOWN` (a 5xx) is treated as **not empty**. Deliberate
 *   direction: a transient GitHub blip must not turn into "your repository is empty".
 *   The cost of being wrong is that Phase 03's indexer finds nothing and reports it,
 *   which is recoverable; the cost of the opposite is a user unable to connect a
 *   perfectly good repository, which is not.
 *
 * ### Step 6 — default branch, kept distinct from step 4
 *
 * A repository with content but no resolvable default branch is a different problem
 * from an empty one, and §3 lists them as separate steps with the explicit instruction
 * that step 6 gets its own message rather than being folded into "empty". It is checked
 * after the size cap so the ordering matches §3 exactly.
 */
export async function assertRepositoryUsable(
  metadata: GithubRepositoryMetadata,
  context: RepositoryUsabilityContext,
): Promise<void> {
  // --- Step 4: empty ---
  if (await isEmptyRepository(metadata, context.probeDefaultBranch)) {
    logger.warn("repository connect rejected: empty repository", {
      projectId: context.projectId,
      userId: context.userId,
      githubRepoId: metadata.githubRepoId.toString(),
      fullName: metadata.fullName,
      sizeKib: metadata.sizeKib,
      defaultBranch: metadata.defaultBranch,
    });
    throw new UnprocessableEntityError(EMPTY_REPOSITORY_MESSAGE, {
      details: { reason: "EMPTY_REPOSITORY", fullName: metadata.fullName },
    });
  }

  // --- Step 5: size cap ---
  if (metadata.sizeKib > REPOSITORY_SIZE_CAP_KIB) {
    logger.warn("repository connect rejected: over the size cap", {
      projectId: context.projectId,
      userId: context.userId,
      githubRepoId: metadata.githubRepoId.toString(),
      fullName: metadata.fullName,
      sizeKib: metadata.sizeKib,
      capKib: REPOSITORY_SIZE_CAP_KIB,
    });
    throw new UnprocessableEntityError(
      `That repository is too large for the current limit (${kibToMib(REPOSITORY_SIZE_CAP_KIB)} MB)`,
      {
        details: {
          reason: "REPOSITORY_TOO_LARGE",
          // Both sides of the comparison, in the unit they were compared in, so a
          // support conversation never has to guess which unit was meant.
          sizeKib: metadata.sizeKib,
          capKib: REPOSITORY_SIZE_CAP_KIB,
        },
      },
    );
  }

  // --- Step 6: default branch resolvable ---
  if (metadata.defaultBranch === null) {
    logger.warn("repository connect rejected: default branch unresolvable", {
      projectId: context.projectId,
      userId: context.userId,
      githubRepoId: metadata.githubRepoId.toString(),
      fullName: metadata.fullName,
      sizeKib: metadata.sizeKib,
    });
    throw new UnprocessableEntityError(DEFAULT_BRANCH_MESSAGE, {
      details: { reason: "DEFAULT_BRANCH_UNRESOLVABLE", fullName: metadata.fullName },
    });
  }
}

/** See step 4's discussion above. Exported so the combination is testable in isolation
 * from the throwing wrapper. */
export async function isEmptyRepository(
  metadata: GithubRepositoryMetadata,
  probeDefaultBranch: BranchProbe,
): Promise<boolean> {
  if (metadata.sizeKib > 0) return false;
  if (metadata.defaultBranch === null) return true;

  return (await probeDefaultBranch()) === "EMPTY";
}
