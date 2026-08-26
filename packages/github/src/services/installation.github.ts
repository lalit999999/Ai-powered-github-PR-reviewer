import type { Octokit } from "@octokit/core";
import { createLogger, type Logger } from "@repo/observability";
import { createInstallationOctokit, createUserOctokit, GITHUB_CLIENT_COMPONENT } from "../client/octokit-factory.js";
import { classifyGithubError, type GithubResult } from "./github-result.js";

/**
 * Thin, typed wrappers over the two *installation-listing* GitHub endpoints this phase
 * uses (phase-02 §9). No service or controller ever holds a raw Octokit — they call
 * these, and get a domain result back.
 *
 * ## The credential asymmetry, stated once
 *
 * `listUserInstallations` is the **only** call in the entire phase authenticated with
 * the signed-in user's **OAuth token**. It has to be: the question it answers — "which
 * installations can *this person* see?" — is about the human, and an installation
 * token cannot answer a question about a human.
 *
 * `listInstallationRepositories`, directly below it, uses the **installation token**,
 * like every other GitHub call in the product. Getting these two backwards is
 * `plan.md` §45's "App installation ≠ OAuth identity" failure point, so the two are
 * deliberately adjacent and each says which credential it uses in its own signature.
 */

const defaultLogger = createLogger(GITHUB_CLIENT_COMPONENT);

/** GitHub's cap for these endpoints. Requesting fewer would mean more round trips for
 * the same data against the same 5,000/hr budget (§21). */
const PER_PAGE = 100;

/**
 * Hard ceiling on pagination, so a malformed `Link` header or an endpoint that never
 * reports a short page cannot spin forever inside a user-facing request. At 100 per
 * page this is 5,000 repositories — far past any installation this product targets,
 * and cheap insurance against an infinite loop.
 */
export const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// GET /user/installations — the USER'S OAuth token
// ---------------------------------------------------------------------------

/** One installation as GitHub describes it, narrowed to what this phase persists. */
export interface GithubInstallationSummary {
  installationId: bigint;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
}

/** The subset of GitHub's installation object this code reads. Declared rather than
 * imported from `@octokit/types`: `@octokit/core` ships no endpoint typings, and
 * hand-declaring exactly the fields that are read makes an upstream shape change a
 * narrowing failure here rather than a silent `undefined` downstream. */
interface RawInstallation {
  id?: number;
  account?: { login?: string; type?: string } | null;
  suspended_at?: string | null;
}

export interface ListUserInstallationsOptions {
  logger?: Logger;
  /** Test seam. Production builds the client from the access token. */
  octokit?: Octokit;
}

/**
 * Lists the App installations visible to the signed-in user.
 *
 * @param accessToken the user's GitHub **OAuth** token, read off the `Account` row by
 *        the repository layer. Never a PAT, never an installation token.
 *
 * A user who has installed nothing gets `{ ok: true, installations: [] }` — that is the
 * "just installed, not yet synced" case from §9 and it is an ordinary empty result, not
 * an error.
 */
export async function listUserInstallations(
  accessToken: string,
  options: ListUserInstallationsOptions = {},
): Promise<GithubResult<{ installations: GithubInstallationSummary[] }>> {
  const logger = options.logger ?? defaultLogger;
  const octokit = options.octokit ?? createUserOctokit(accessToken, { logger });

  try {
    const installations: GithubInstallationSummary[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await octokit.request("GET /user/installations", { per_page: PER_PAGE, page });
      const body = response.data as { total_count?: number; installations?: RawInstallation[] };
      const batch = body.installations ?? [];

      for (const raw of batch) {
        const summary = toInstallationSummary(raw);
        if (summary) installations.push(summary);
      }

      if (batch.length < PER_PAGE) break;
    }

    logger.info("listed user installations", {
      installationId: null,
      endpoint: "GET /user/installations",
      count: installations.length,
    });

    return { ok: true, installations };
  } catch (error) {
    const reason = classifyGithubError(error);
    logger.warn("failed to list user installations", {
      installationId: null,
      endpoint: "GET /user/installations",
      reason,
    });
    return { ok: false, reason };
  }
}

/** Drops an installation GitHub described without the fields this system needs, rather
 * than persisting a row with a fabricated `accountLogin`. */
function toInstallationSummary(raw: RawInstallation): GithubInstallationSummary | null {
  const login = raw.account?.login;
  if (typeof raw.id !== "number" || typeof login !== "string") return null;

  return {
    installationId: BigInt(raw.id),
    accountLogin: login,
    // GitHub reports "User" or "Organization"; a missing type is stored as-is rather
    // than guessed, because it only ever drives display.
    accountType: raw.account?.type ?? "Unknown",
    suspended: Boolean(raw.suspended_at),
  };
}

// ---------------------------------------------------------------------------
// GET /installation/repositories — the INSTALLATION token
// ---------------------------------------------------------------------------

export interface InstallationRepositorySummary {
  githubRepoId: bigint;
  owner: string;
  name: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
}

interface RawRepository {
  id?: number;
  name?: string;
  full_name?: string;
  private?: boolean;
  default_branch?: string | null;
  owner?: { login?: string } | null;
}

export interface ListInstallationRepositoriesOptions {
  logger?: Logger;
  octokit?: Octokit;
}

/**
 * Every repository the installation can access, **fully paginated**.
 *
 * The obvious bug here is stopping at the first page: an installation with 150
 * repositories would silently show 100 in the picker, and the missing 50 would look
 * like a permissions problem rather than a pagination one. The loop runs until GitHub
 * returns a short page (or {@link MAX_PAGES}); `total_count` is deliberately *not*
 * used as the terminator, because it counts repositories the installation is entitled
 * to rather than the ones this listing returns, and trusting it would either truncate
 * or loop.
 *
 * Uses the **installation token** — see this file's header on the credential
 * asymmetry.
 */
export async function listInstallationRepositories(
  installationId: bigint,
  options: ListInstallationRepositoriesOptions = {},
): Promise<GithubResult<{ repositories: InstallationRepositorySummary[] }>> {
  const logger = options.logger ?? defaultLogger;
  const octokit = options.octokit ?? createInstallationOctokit(installationId, { logger });

  try {
    const repositories: InstallationRepositorySummary[] = [];
    let pages = 0;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      pages = page;
      const response = await octokit.request("GET /installation/repositories", { per_page: PER_PAGE, page });
      const body = response.data as { total_count?: number; repositories?: RawRepository[] };
      const batch = body.repositories ?? [];

      for (const raw of batch) {
        const summary = toRepositorySummary(raw);
        if (summary) repositories.push(summary);
      }

      if (batch.length < PER_PAGE) break;
    }

    logger.info("listed installation repositories", {
      installationId: installationId.toString(),
      endpoint: "GET /installation/repositories",
      count: repositories.length,
      pages,
    });

    return { ok: true, repositories };
  } catch (error) {
    const reason = classifyGithubError(error);
    logger.warn("failed to list installation repositories", {
      installationId: installationId.toString(),
      endpoint: "GET /installation/repositories",
      reason,
    });
    return { ok: false, reason };
  }
}

/** A repository GitHub described without an id, name, or owner cannot be connected, so
 * it is dropped rather than surfaced as a picker entry that would fail on selection.
 * An empty repository legitimately has no `default_branch`; it is kept, and the
 * validation chain rejects it later with the specific "repository is empty" error. */
function toRepositorySummary(raw: RawRepository): InstallationRepositorySummary | null {
  const owner = raw.owner?.login;
  if (typeof raw.id !== "number" || typeof raw.name !== "string" || typeof owner !== "string") return null;

  return {
    githubRepoId: BigInt(raw.id),
    owner,
    name: raw.name,
    fullName: raw.full_name ?? `${owner}/${raw.name}`,
    isPrivate: raw.private ?? true,
    defaultBranch: raw.default_branch ?? "",
  };
}
