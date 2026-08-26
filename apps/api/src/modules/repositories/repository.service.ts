import { randomUUID } from "node:crypto";
import { installationGithub, repositoryGithub } from "@repo/github";
import { emitRepositoryIndexRequested } from "../../inngest/emit.js";
import type { OwnerContext, TenantContext } from "../../lib/auth/tenant-access.js";
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthenticatedError,
} from "../../lib/errors.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { createLogger } from "@repo/observability";
import * as indexJobRepository from "./index-job.repository.js";
import * as installationRepository from "./installation.repository.js";
import {
  NO_ACCESS_MESSAGE,
  assertNotAlreadyConnected,
  assertRepositoryAccessible,
  assertRepositoryUsable,
  resolveRepoRefFromUrl,
} from "./repository-validation.service.js";
import * as repositoryRepository from "./repository.repository.js";
import type { ConnectRepositoryBody, GithubRepoRef, ListInstallationReposQuery, TriggerIndexBody } from "./repository.schema.js";
import {
  toIndexJobSummaryDto,
  toRepositoryDto,
  toInstallationDto,
  type IndexStatusDto,
  type InstallationDto,
  type InstallationRepositoryDto,
  type RepositoryDetail,
  type RepositoryDto,
} from "./repository.types.js";

/**
 * Business logic for repositories and GitHub installations. Every function takes the
 * tenant context as its **required first argument** (plan.md §34.2) — collection
 * operations take an `OwnerContext`, single-repository operations take the
 * `TenantContext` that `requireTenantAccess` already resolved. It is never optional and
 * never derived from a request object: this module has no idea what an HTTP request is.
 *
 * Rule B holds here: this file imports no Prisma. `repository.repository.ts` and
 * `installation.repository.ts` own every query.
 */

const logger = createLogger("repository.service");

/** GitHub reports repository size in KiB (verified empirically — see
 * `REPOSITORY_SIZE_CAP_KIB`). The column is named `sizeBytes`, so the conversion
 * happens here, once, at the only place a size is written. phase-02-log §4 flagged
 * this exact unit mismatch as a choice Prompt 2 had to make deliberately. */
const BYTES_PER_KIB = 1024;

// ---------------------------------------------------------------------------
// Installation sync — the page-load attribution path (§10, narrowed by Phase 06)
// ---------------------------------------------------------------------------

/**
 * Refreshes this user's `GithubInstallation` rows from `GET /user/installations`.
 *
 * ## No longer a staleness fallback — Phase 06 narrowed this to attribution only
 *
 * `installation`/`installation_repositories` webhooks (`modules/webhooks/
 * installation-sync.ts`) now keep `GithubInstallation`/`Repository` rows current as
 * GitHub's own state changes, so this function is no longer standing in for a missing
 * webhook receiver (that was true through Phase 02–05; see `github.controller.ts`'s
 * `listInstallations` for the up-to-date framing).
 *
 * What this function alone still does, and permanently: **attribution**. A webhook
 * payload carries the GitHub account an App was installed on, never which of this
 * product's users is signed in — see `installation-sync.ts`'s header comment for the
 * full argument. Only a page load, driven by the caller's own OAuth token, can answer
 * "does *this* user own this installation" and write a `GithubInstallation` row with a
 * `userId` attached; `installation.created`'s webhook handler is deliberately
 * update-only for exactly this reason.
 *
 * The "user just installed, not yet synced" case from §9 is an **empty array**, not an
 * error: a user who has installed nothing and a user whose install has not propagated
 * are indistinguishable here, and both should see "no installations yet — install the
 * App" rather than a failure.
 *
 * Uses the **user's OAuth token**, the only call in the phase that does. See
 * `installation.github.ts`'s header for why.
 */
export async function syncInstallations(owner: OwnerContext): Promise<InstallationDto[]> {
  const accessToken = await installationRepository.findGithubAccessToken(owner.userId);

  if (!accessToken) {
    // Every user in this system signed in through GitHub OAuth, so a missing token
    // means the Account row predates token storage or the grant was revoked on
    // GitHub's side. A 401 is the honest answer *and* the actionable one: signing in
    // again is exactly what fixes it.
    logger.warn("installation sync failed: no stored GitHub OAuth token", { userId: owner.userId });
    throw new UnauthenticatedError("Your GitHub sign-in needs to be refreshed — sign out and back in");
  }

  const result = await installationGithub.listUserInstallations(accessToken);

  if (!result.ok) {
    if (result.reason === "UNAUTHENTICATED") {
      logger.warn("installation sync failed: GitHub rejected the stored OAuth token", { userId: owner.userId });
      throw new UnauthenticatedError("Your GitHub sign-in needs to be refreshed — sign out and back in");
    }
    logger.warn("installation sync failed: GitHub unavailable", {
      userId: owner.userId,
      reason: result.reason,
    });
    throw new ServiceUnavailableError("GitHub is temporarily unavailable, try again");
  }

  const rows = [];
  for (const installation of result.installations) {
    rows.push(
      await installationRepository.upsertInstallation({
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        userId: owner.userId,
        suspendedAt: installation.suspended ? new Date() : null,
      }),
    );
  }

  logger.info("installations synced", {
    userId: owner.userId,
    count: rows.length,
    // §20: installationId on every log line in this phase's paths. A list has many, so
    // the list is what is logged.
    installationIds: rows.map((row) => row.installationId.toString()),
  });

  return rows.map(toInstallationDto);
}

/** The stored view, without a GitHub round trip. What `GET /api/github/installations`
 * returns after a sync. */
export async function listInstallations(owner: OwnerContext): Promise<InstallationDto[]> {
  const rows = await installationRepository.listInstallationsForUser(owner.userId);
  return rows.map(toInstallationDto);
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

/**
 * The repositories one installation can reach, for the connect picker.
 *
 * **The ownership cross-check happens server-side, before any GitHub call** (§13:
 * "scoped to installations the requesting user owns, cross-checked via
 * `GithubInstallation.userId`, never trusted from client input"). An installation id is
 * a GitHub-global number, so without this check any signed-in user could enumerate any
 * installation's private repository names by guessing ids — the whole point of the
 * requirement.
 *
 * 403 rather than this repo's usual 404 for an ownership failure. That is a deliberate,
 * narrow exception argued in `github.controller.ts`.
 *
 * `?q` is applied **server-side** so a large installation does not ship every private
 * repository name to the browser to be filtered there.
 */
export async function listInstallationRepositories(
  owner: OwnerContext,
  installationId: bigint,
  query: ListInstallationReposQuery,
): Promise<InstallationRepositoryDto[]> {
  await requireInstallationOwnership(owner, installationId);

  const result = await installationGithub.listInstallationRepositories(installationId);

  if (!result.ok) {
    logger.warn("installation repository listing failed", {
      userId: owner.userId,
      installationId: installationId.toString(),
      reason: result.reason,
    });
    if (result.reason === "NOT_ACCESSIBLE") {
      // The row says this user owns the installation, but GitHub says the App cannot
      // use it — an uninstall or suspension that the polling sync has not caught up
      // with yet. Phase 06's webhooks close this window.
      throw new ForbiddenError(NO_ACCESS_MESSAGE);
    }
    throw new ServiceUnavailableError("GitHub is temporarily unavailable, try again");
  }

  const needle = query.q?.toLowerCase();
  const matches = needle
    ? result.repositories.filter((repo) => repo.fullName.toLowerCase().includes(needle))
    : result.repositories;

  logger.info("listed installation repositories", {
    userId: owner.userId,
    installationId: installationId.toString(),
    total: result.repositories.length,
    matched: matches.length,
    filtered: needle !== undefined,
  });

  return matches.map((repo) => ({
    githubRepoId: repo.githubRepoId.toString(),
    fullName: repo.fullName,
    isPrivate: repo.isPrivate,
    defaultBranch: repo.defaultBranch,
  }));
}

async function requireInstallationOwnership(owner: OwnerContext, installationId: bigint): Promise<void> {
  const installation = await installationRepository.findInstallationForUser(owner.userId, installationId);

  if (!installation) {
    logger.warn("installation access denied", {
      userId: owner.userId,
      installationId: installationId.toString(),
      // "not yours" and "no such installation" are one answer here, deliberately —
      // findInstallationForUser puts both halves of the key in the WHERE.
      reason: "NOT_OWNED",
    });
    throw new ForbiddenError("That GitHub installation is not available to your account");
  }
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

/**
 * The core path (§3, §7): resolve the target, fetch its metadata **once**, run the
 * validation chain against that one object, create the row, emit the index request.
 *
 * ## Canonical values come from GitHub, never from the user's input
 *
 * `owner`, `name`, `fullName`, `defaultBranch`, `isPrivate` and `htmlUrl` are all taken
 * from the `GET /repos/{o}/{r}` **response**, not from the URL the user typed. GitHub
 * lookups are case-insensitive, so `github.com/OCTOCAT/hello-world` resolves fine and
 * would otherwise be stored with a spelling that matches nothing GitHub ever sends
 * back — including in webhook payloads Phase 06 has to match against these rows.
 *
 * ## Every outcome is logged distinctly (§20)
 *
 * Success logs `repositoryId`, `projectId`, `userId`, `installationId`. Each failure
 * logs the attempted `githubRepoId`/`repoUrl` with `projectId` and `userId` — from
 * here for the target-resolution failures, and from
 * `repository-validation.service` for the chain's own. The requirement is that the
 * failures are distinguishable **in the logs**, not only in the HTTP response.
 */
export async function connectRepository(
  tenant: TenantContext,
  input: ConnectRepositoryBody,
): Promise<RepositoryDto> {
  const target = describeTarget(input);
  const { installationId, ref } = await resolveConnectTarget(tenant, input);

  // ---- The single GET /repos/{o}/{r} for this connect attempt (§21). ----
  const fetched = await repositoryGithub.getRepository(installationId, ref.owner, ref.repo);

  // Step 2 — access.
  const metadata = assertRepositoryAccessible(fetched, {
    projectId: tenant.projectId,
    userId: tenant.userId,
    target,
  });

  // Step 3 — already connected to THIS project. Keyed on the composite, never on
  // githubRepoId alone: the same repository under a different project is not a
  // conflict (§4/§15).
  const existing = await repositoryRepository.findByProjectAndGithubRepoId(tenant.projectId, metadata.githubRepoId);
  assertNotAlreadyConnected(existing, {
    projectId: tenant.projectId,
    userId: tenant.userId,
    githubRepoId: metadata.githubRepoId,
  });

  // Steps 4–6 — emptiness, size cap, default branch. All against the one metadata
  // object; the probe only runs in the ambiguous size-0 case.
  await assertRepositoryUsable(metadata, {
    projectId: tenant.projectId,
    userId: tenant.userId,
    probeDefaultBranch: () =>
      repositoryGithub.probeBranch(installationId, metadata.owner, metadata.name, metadata.defaultBranch ?? ""),
  });

  const created = await repositoryRepository.create({
    projectId: tenant.projectId,
    installationId,
    githubRepoId: metadata.githubRepoId,
    owner: metadata.owner,
    name: metadata.name,
    fullName: metadata.fullName,
    // Non-null by construction: step 6 above rejects a null default branch.
    defaultBranch: metadata.defaultBranch ?? "",
    isPrivate: metadata.isPrivate,
    htmlUrl: metadata.htmlUrl,
    sizeBytes: metadata.sizeKib * BYTES_PER_KIB,
  });

  if (!created.ok) {
    // The pre-check above raced and lost: two simultaneous connects of the same
    // repository both saw "not connected". The unique constraint is what actually
    // held, and it produces the same 409 the pre-check would have.
    logger.warn("repository connect lost the unique-constraint race", {
      projectId: tenant.projectId,
      userId: tenant.userId,
      installationId: installationId.toString(),
      githubRepoId: metadata.githubRepoId.toString(),
    });
    throw new ConflictError("That repository is already connected to this project");
  }

  const repository = created.repository;

  logger.info("repository connected", {
    repositoryId: repository.id,
    projectId: tenant.projectId,
    userId: tenant.userId,
    installationId: installationId.toString(),
    githubRepoId: repository.githubRepoId.toString(),
    fullName: repository.fullName,
    indexStatus: repository.indexStatus,
  });

  // Deliberately not awaited, for the reasons argued at length in
  // `emitRepositoryIndexRequested` — the row is committed in PENDING and is the
  // durable record; the 202 must not wait on a channel with no consumers in this
  // phase. The helper swallows and logs its own failures at `error`, so this can never
  // surface as an unhandled rejection.
  void emitRepositoryIndexRequested({
    projectId: tenant.projectId,
    repositoryId: repository.id,
    mode: "FULL",
    reason: "connected",
  });

  return toRepositoryDto(repository);
}

/** For log lines and error details: what the caller actually asked for, before
 * anything was resolved. */
function describeTarget(input: ConnectRepositoryBody): string {
  return input.repoUrl ?? `githubRepoId:${input.githubRepoId?.toString() ?? "?"}`;
}

/**
 * Works out **which installation** to make the call through, and the `{owner, repo}`
 * that addresses it.
 *
 * §7's request body carries neither an installation id nor an owner, so this has to be
 * derived — and it must be derived from the user's *own* installations, because §13
 * requires access be verified through the installation rather than through anything the
 * client submitted.
 *
 * - **URL path**: the URL's owner segment names a GitHub account, and a GitHub App
 *   installation *is* per account — so the installation whose `accountLogin` matches is
 *   the only one that could possibly have access. One lookup, no GitHub calls.
 *   Case-insensitive, because GitHub account names are.
 * - **Id path**: a repository id carries no owner, so the user's installations are
 *   searched in turn until one lists it. This is the one place in the connect flow that
 *   costs more than a constant number of calls; ETag caching (built in Prompt 1) makes
 *   repeat listings free against the rate-limit budget, and users have one or two
 *   installations in practice. Recorded in the decision log as an under-specification
 *   of §7 — an `installationId` in the request body would make this a single lookup,
 *   and the picker already knows it.
 *
 * No matching installation is a **403 with the installation-settings message**, the
 * same answer as "the App can't see this repo" — because from the user's side it is the
 * same problem with the same fix.
 */
async function resolveConnectTarget(
  tenant: TenantContext,
  input: ConnectRepositoryBody,
): Promise<{ installationId: bigint; ref: GithubRepoRef }> {
  const installations = await installationRepository.listInstallationsForUser(tenant.userId);

  if (installations.length === 0) {
    logger.warn("repository connect rejected: user has no synced installations", {
      projectId: tenant.projectId,
      userId: tenant.userId,
      target: describeTarget(input),
    });
    throw new ForbiddenError(NO_ACCESS_MESSAGE);
  }

  if (input.repoUrl !== undefined) {
    // Step 1 of the chain. Re-parsed here even though the request schema already did —
    // see resolveRepoRefFromUrl's doc comment.
    const ref = resolveRepoRefFromUrl(input.repoUrl);
    const match = installations.find((row) => row.accountLogin.toLowerCase() === ref.owner.toLowerCase());

    if (!match) {
      logger.warn("repository connect rejected: no installation on that account", {
        projectId: tenant.projectId,
        userId: tenant.userId,
        repoUrl: input.repoUrl,
        owner: ref.owner,
      });
      throw new ForbiddenError(NO_ACCESS_MESSAGE);
    }

    return { installationId: match.installationId, ref };
  }

  const githubRepoId = input.githubRepoId;
  if (githubRepoId === undefined) {
    // The schema enforces exactly-one, so this is unreachable over HTTP. A 500 rather
    // than a guess: a caller that got here has a bug, and picking a branch for them
    // would hide it.
    throw new InternalError("connectRepository called with neither repoUrl nor githubRepoId");
  }

  for (const installation of installations) {
    const listed = await installationGithub.listInstallationRepositories(installation.installationId);
    if (!listed.ok) continue;

    const match = listed.repositories.find((repo) => repo.githubRepoId === githubRepoId);
    if (match) {
      return {
        installationId: installation.installationId,
        ref: { owner: match.owner, repo: match.name },
      };
    }
  }

  logger.warn("repository connect rejected: id not visible to any of this user's installations", {
    projectId: tenant.projectId,
    userId: tenant.userId,
    githubRepoId: githubRepoId.toString(),
    installationCount: installations.length,
  });
  throw new ForbiddenError(NO_ACCESS_MESSAGE);
}

// ---------------------------------------------------------------------------
// Read, list, disconnect
// ---------------------------------------------------------------------------

/**
 * `GET /api/repositories/:id` (§7).
 *
 * `requireTenantAccess` has already proved ownership; this still re-reads through the
 * project-scoped query rather than trusting that proof — defence in depth, and it
 * closes the window where the repository is removed between the tenancy check and this
 * read. Same discipline as `getProjectDetail`.
 */
export async function getRepositoryDetail(tenant: TenantContext): Promise<RepositoryDetail> {
  const repositoryId = requireRepositoryId(tenant);
  const [repository, job] = await Promise.all([
    repositoryRepository.findByIdForProject(tenant.projectId, repositoryId),
    indexJobRepository.findLatestForRepository(repositoryId),
  ]);

  if (!repository) {
    throw new NotFoundError("Project not found");
  }

  // `indexJob` was typed as literal `null` until this phase, specifically so this
  // widening was a compile error at every call site rather than a silent no-op — see
  // RepositoryDetail. `null` remains a real value: a freshly-connected repository has no
  // IndexJob row yet.
  return { repository: toRepositoryDto(repository), indexJob: job ? toIndexJobSummaryDto(job) : null };
}

/**
 * `GET /api/repositories/:id/index-status` (§7) — deliberately separate from
 * `getRepositoryDetail` so the route can poll cheaply (`plan.md` §28's design notes):
 * one `IndexJob` row, not the full repository payload plus a join.
 *
 * **Falls back to the `Repository` row's own `indexStatus`/`indexError` when no
 * `IndexJob` exists yet** — a repository between "just connected" and "the worker's step
 * 1 has run" has no job row at all (the worker is the only writer, and it creates the
 * row `RUNNING`, never `PENDING` — see `apps/worker`'s `index-job.repository.ts`).
 * Without this fallback the very first poll after a connect would have nothing
 * meaningful to show; with it, the client sees `PENDING` immediately, which is honest —
 * that is genuinely the repository's state at that moment.
 */
export async function getIndexStatus(tenant: TenantContext): Promise<IndexStatusDto> {
  const repositoryId = requireRepositoryId(tenant);
  const [repository, job] = await Promise.all([
    repositoryRepository.findByIdForProject(tenant.projectId, repositoryId),
    indexJobRepository.findLatestForRepository(repositoryId),
  ]);

  if (!repository) {
    throw new NotFoundError("Project not found");
  }

  if (job) {
    return {
      status: job.status,
      currentStep: job.currentStep,
      progressPercent: job.progressPercent,
      filesTotal: job.filesTotal,
      filesProcessed: job.filesProcessed,
      error: job.error,
    };
  }

  return {
    status: repository.indexStatus,
    currentStep: null,
    progressPercent: 0,
    filesTotal: 0,
    filesProcessed: 0,
    error: repository.indexError,
  };
}

/** `POST /api/repositories/:id/index`'s 10/hour/repository limit (§7/§28). */
const TRIGGER_INDEX_RATE_LIMIT_PER_HOUR = 10;

/**
 * `POST /api/repositories/:id/index` (§7) — a forced re-index, distinct from the
 * automatic one `connectRepository` triggers. `input.mode` is asserted `"FULL"` here as
 * well as at the schema boundary (`triggerIndexBodySchema` already rejects
 * `"INCREMENTAL"` with 400) — defence in depth, the same discipline
 * `resolveRepoRefFromUrl` uses for a URL the schema already validated once.
 *
 * **The `IndexJob` row does not exist yet when this returns.** The worker's
 * `repository-index.ts` step 1 is the only writer of `IndexJob` (§27.6: "Inngest is the
 * executor"), but this route must answer `{ indexJobId }` synchronously (§7) — so the id
 * is generated *here* and carried on the emitted event; the worker's `createIndexJob`
 * adopts it instead of generating its own (`@repo/shared`'s `RepositoryIndexRequestedData.indexJobId`,
 * added this phase specifically for this). See docs/decisions/phase-03-log.md for the
 * narrow, accepted race this leaves open (a lock lost to a concurrent run between this
 * check and the worker's own means the pre-allocated id is never actually created) — low
 * consequence, since neither this route nor `/index-status` requires the client to poll
 * *by* this id.
 */
export async function triggerIndex(tenant: TenantContext, input: TriggerIndexBody): Promise<{ indexJobId: string }> {
  const repositoryId = requireRepositoryId(tenant);

  if (input.mode !== "FULL") {
    // Unreachable over HTTP — triggerIndexBodySchema already rejects INCREMENTAL with
    // 400. A 500 rather than a guess, for the same reason connectRepository's own
    // "neither repoUrl nor githubRepoId" branch is.
    throw new InternalError("triggerIndex called with a mode other than FULL");
  }

  const rate = await checkRateLimit(`repo-index:${repositoryId}`, TRIGGER_INDEX_RATE_LIMIT_PER_HOUR);
  if (!rate.allowed) {
    logger.warn("repository index trigger rate-limited", {
      repositoryId,
      projectId: tenant.projectId,
      userId: tenant.userId,
      retryAfterSeconds: rate.retryAfterSeconds,
    });
    throw new TooManyRequestsError("Too many index requests for this repository — try again later", {
      details: { retryAfterSeconds: rate.retryAfterSeconds },
    });
  }

  const repository = await repositoryRepository.findByIdForProject(tenant.projectId, repositoryId);
  if (!repository) {
    throw new NotFoundError("Project not found");
  }

  if (repository.indexStatus === "INDEXING") {
    logger.info("repository index trigger rejected — already indexing", {
      repositoryId,
      projectId: tenant.projectId,
      userId: tenant.userId,
    });
    throw new ConflictError("This repository is already being indexed");
  }

  const indexJobId = randomUUID();

  logger.info("repository index triggered manually", {
    repositoryId,
    projectId: tenant.projectId,
    userId: tenant.userId,
    indexJobId,
  });

  // Fire-and-forget for the same reasons emitRepositoryIndexRequested's own doc comment
  // argues at length — the durable record here is the pre-allocated id itself, already
  // returned to the caller; awaiting the send would not make delivery more reliable, only
  // slower.
  void emitRepositoryIndexRequested({
    projectId: tenant.projectId,
    repositoryId,
    mode: "FULL",
    reason: "manual",
    indexJobId,
  });

  return { indexJobId };
}

/** The project's active repositories, for `GET /api/projects/:id`. `DISCONNECTED` rows
 * are excluded by the repository layer; `ACCESS_LOST` ones are not, because they are
 * still connected and the user needs to see the problem. */
export async function listProjectRepositories(tenant: TenantContext): Promise<RepositoryDto[]> {
  const rows = await repositoryRepository.listByProject(tenant.projectId);
  return rows.map(toRepositoryDto);
}

/**
 * `DELETE /api/repositories/:id` (§7, §11) — soft: `connectionStatus = DISCONNECTED`.
 * The row survives, so a completed index and the connection history are not destroyed
 * by a disconnect the user may reverse.
 *
 * **Idempotent**, following `softDeleteProject`'s precedent: a repeat call succeeds and
 * does not overwrite the original transition (`markDisconnected` reports 0 rows changed
 * because `connectionStatus` is already `DISCONNECTED`).
 *
 * **Cascading job cancellation is still a no-op for a plain repository disconnect,
 * deliberately, not by omission.** Phase 03 makes the *project-deletion* cascade real —
 * `repository-index.ts` carries `cancelOn: [{ event: projectDeleted, ... }]`, so deleting
 * a project now genuinely cancels any in-flight index for every repository under it. A
 * disconnect that leaves the *project* intact has no equivalent: there is no
 * `repository/disconnected` event, and wiring one up (plus a second `cancelOn` entry) is
 * a real, if small, design surface this phase's own scope list does not name. Recorded
 * as an open gap rather than silently left for a future reader to rediscover: an
 * in-flight index for a repository the user just disconnected currently runs to
 * completion and still writes its result, which is harmless (the row is soft-disconnected,
 * not deleted, so a completed index is not wasted if the user reconnects) but is not the
 * same guarantee project-deletion now has. See docs/decisions/phase-03-log.md.
 */
export async function disconnectRepository(tenant: TenantContext): Promise<void> {
  const repositoryId = requireRepositoryId(tenant);
  const changed = await repositoryRepository.markDisconnected(tenant.projectId, repositoryId);

  if (changed === 0) {
    logger.info("repository disconnect no-op (already disconnected)", {
      repositoryId,
      projectId: tenant.projectId,
      userId: tenant.userId,
    });
    return;
  }

  logger.info("repository disconnected", {
    repositoryId,
    projectId: tenant.projectId,
    userId: tenant.userId,
  });
}

/**
 * `TenantContext.repositoryId` is optional because the same type serves the
 * project-only routes. A repository operation reached without one means the handler
 * called `requireTenantAccess` with the wrong resource — a programming error, and a 500
 * rather than a silent fallback, for the same reason `requireTenantAccess` throws
 * `InternalError` when it can resolve nothing.
 */
function requireRepositoryId(tenant: TenantContext): string {
  if (!tenant.repositoryId) {
    throw new InternalError("repository service called with a TenantContext that names no repository");
  }
  return tenant.repositoryId;
}
