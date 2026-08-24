import type { Octokit } from "@octokit/core";
import { createLogger, type Logger } from "../../lib/logger.js";
import { createInstallationOctokit, GITHUB_CLIENT_COMPONENT } from "../client/octokit-factory.js";
import { classifyGithubError, statusOf, type GithubResult } from "./github-result.js";

/**
 * `GET /repos/{owner}/{repo}` (phase-02 §9), wrapped.
 *
 * **This is the phase's single most cost-sensitive call.** §21 names it: the metadata
 * fetch must happen **once per connect attempt**, with its result passed through every
 * validation sub-check — not re-fetched per check. That property is enforced
 * *structurally* rather than by discipline: `repository-validation.service` takes an
 * already-fetched {@link GithubRepositoryMetadata} as an argument and has no way to
 * fetch one, so "call it once" is the only thing it can do.
 */

const defaultLogger = createLogger(GITHUB_CLIENT_COMPONENT);

/**
 * Everything the validation chain (§3) needs, and nothing else.
 *
 * `defaultBranch` is `string | null` on purpose: GitHub reports a `default_branch` for
 * every repository *except* one with no commits, where the field is present but names
 * a branch that does not exist yet. Modelling it as nullable is what lets step 6
 * ("default branch resolvable") be a real check rather than a formality — see
 * `isEmpty` below.
 */
export interface GithubRepositoryMetadata {
  githubRepoId: bigint;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string | null;
  isPrivate: boolean;
  htmlUrl: string;
  /**
   * **KiB, not bytes.** GitHub's `size` field on `GET /repos` is documented in
   * kilobytes and is the size of the *git* repository (the packed objects), not a
   * working-tree checkout. The field name says `Kib` so no comparison anywhere can
   * quietly treat it as bytes — see `REPOSITORY_SIZE_CAP_KIB` in
   * repository-validation.service.ts, and docs/decisions/phase-02-log.md for what
   * could and could not be verified about this unit from here.
   */
  sizeKib: number;
  /** GitHub's own emptiness signal, kept separate from the derived `isEmpty` so the
   * validator can combine signals rather than trusting either alone. */
  archived: boolean;
  disabled: boolean;
}

/** The subset of GitHub's repository object that is read. Hand-declared: see the note
 * in installation.github.ts. */
interface RawRepository {
  id?: number;
  name?: string;
  full_name?: string;
  private?: boolean;
  default_branch?: string | null;
  size?: number;
  html_url?: string;
  archived?: boolean;
  disabled?: boolean;
  owner?: { login?: string } | null;
}

export interface GetRepositoryOptions {
  logger?: Logger;
  /** Test seam. Production builds an installation-scoped client. */
  octokit?: Octokit;
}

/**
 * Fetches one repository's metadata using the **installation token**.
 *
 * A `404` comes back as `{ ok: false, reason: "NOT_ACCESSIBLE" }` — GitHub returns 404
 * rather than 403 for a repository an installation cannot see (§12), so "does not
 * exist" and "you cannot see it" are genuinely indistinguishable at the HTTP layer.
 * This wrapper reports the one honest answer instead of guessing; see
 * `github-result.ts` for the full argument.
 *
 * `MALFORMED` is its own outcome rather than an exception: a 200 whose body is missing
 * an id or an owner means the response is not what this code understands, which is a
 * bug or an upstream change — not a permission state, and specifically not a reason to
 * tell a user the App lacks access.
 */
export async function getRepository(
  installationId: bigint,
  owner: string,
  repo: string,
  options: GetRepositoryOptions = {},
): Promise<GithubResult<{ repository: GithubRepositoryMetadata }>> {
  const logger = options.logger ?? defaultLogger;
  const octokit = options.octokit ?? createInstallationOctokit(installationId, { logger });

  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
    const metadata = toMetadata(response.data as RawRepository);

    if (!metadata) {
      logger.warn("github returned a repository body this code does not understand", {
        installationId: installationId.toString(),
        endpoint: "GET /repos/{owner}/{repo}",
        fullName: `${owner}/${repo}`,
      });
      return { ok: false, reason: "UNAVAILABLE" };
    }

    logger.info("fetched repository metadata", {
      installationId: installationId.toString(),
      endpoint: "GET /repos/{owner}/{repo}",
      githubRepoId: metadata.githubRepoId.toString(),
      fullName: metadata.fullName,
      sizeKib: metadata.sizeKib,
    });

    return { ok: true, repository: metadata };
  } catch (error) {
    const reason = classifyGithubError(error);
    logger.warn("failed to fetch repository metadata", {
      installationId: installationId.toString(),
      endpoint: "GET /repos/{owner}/{repo}",
      fullName: `${owner}/${repo}`,
      reason,
    });
    return { ok: false, reason };
  }
}

function toMetadata(raw: RawRepository): GithubRepositoryMetadata | null {
  const owner = raw.owner?.login;
  if (typeof raw.id !== "number" || typeof raw.name !== "string" || typeof owner !== "string") return null;

  return {
    githubRepoId: BigInt(raw.id),
    owner,
    name: raw.name,
    fullName: raw.full_name ?? `${owner}/${raw.name}`,
    // An empty string is normalized to null so callers have one emptiness signal to
    // check rather than two.
    defaultBranch: raw.default_branch != null && raw.default_branch !== "" ? raw.default_branch : null,
    isPrivate: raw.private ?? true,
    htmlUrl: raw.html_url ?? `https://github.com/${owner}/${raw.name}`,
    sizeKib: typeof raw.size === "number" ? raw.size : 0,
    archived: raw.archived ?? false,
    disabled: raw.disabled ?? false,
  };
}


// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/branches/{branch} — the ambiguity breaker
// ---------------------------------------------------------------------------

/**
 * Whether a named branch exists on a repository the installation can already read.
 *
 * `EMPTY` here means "the default branch has no commits", which is what a `404` on this
 * endpoint means once {@link getRepository} has already succeeded for the same
 * repository — the repo is reachable, the ref is not.
 */
export type BranchProbeResult = "HAS_COMMITS" | "EMPTY" | "UNKNOWN";

/**
 * **Called only when `GET /repos` reported `sizeKib === 0`**, which is ambiguous: it is
 * how GitHub describes a repository with no commits, and also how it describes one
 * pushed moments ago, because that `size` is computed asynchronously rather than at
 * request time. Rejecting on `size === 0` alone would turn "you just created this
 * repository and pushed to it" into "this repository is empty", which is both wrong
 * and maddening.
 *
 * So this is the tie-breaker, and it is deliberately **not** on the happy path: a
 * repository with any content at all never triggers it, so §21's rate-limit budget is
 * untouched for every ordinary connect.
 *
 * `UNKNOWN` (a 5xx, or anything this code cannot interpret) is a real outcome rather
 * than an error, because the validator's policy for it is "assume non-empty" — see
 * repository-validation.service.ts. Failing a legitimate connect because GitHub had a
 * bad second is worse than letting Phase 03's indexer discover an empty repository.
 */
export async function probeBranch(
  installationId: bigint,
  owner: string,
  repo: string,
  branch: string,
  options: GetRepositoryOptions = {},
): Promise<BranchProbeResult> {
  const logger = options.logger ?? defaultLogger;
  const octokit = options.octokit ?? createInstallationOctokit(installationId, { logger });

  try {
    await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", { owner, repo, branch });
    logger.info("default branch probe found commits", {
      installationId: installationId.toString(),
      endpoint: "GET /repos/{owner}/{repo}/branches/{branch}",
      fullName: `${owner}/${repo}`,
      branch,
    });
    return "HAS_COMMITS";
  } catch (error) {
    // A 404 on the *branch* of a repository whose metadata we just read successfully
    // is not an access answer — access was already proved one call ago.
    const result: BranchProbeResult = statusOf(error) === 404 ? "EMPTY" : "UNKNOWN";
    logger.warn("default branch probe did not find commits", {
      installationId: installationId.toString(),
      endpoint: "GET /repos/{owner}/{repo}/branches/{branch}",
      fullName: `${owner}/${repo}`,
      branch,
      result,
    });
    return result;
  }
}
