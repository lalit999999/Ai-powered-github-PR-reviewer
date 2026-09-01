import type { Octokit } from "@octokit/core";
import { createLogger, type Logger } from "@repo/observability";
import {
  MAX_FILES_FETCHED,
  PULL_REQUEST_FILE_STATUSES,
  type PullRequestFileStatus,
} from "@repo/shared";
import {
  createInstallationOctokit,
  GITHUB_CLIENT_COMPONENT,
} from "../client/octokit-factory.js";
import {
  classifyGithubError,
  type GithubResult,
} from "./github-result.js";

/**
 * Thin, typed wrappers over the PR-shaped GitHub endpoints Phase 07's ingestion pipeline
 * needs: PR metadata, the open-PR list (Prompt 5's sync source), paginated changed files,
 * and the whole-PR diff fallback for files GitHub omits a `patch` on. Follows
 * `repository.github.ts`'s exact discipline — read that file's header before this one.
 */

const defaultLogger = createLogger(GITHUB_CLIENT_COMPONENT);

export interface PullRequestGithubOptions {
  logger?: Logger;
  /** Test seam. Production builds an installation-scoped client. */
  octokit?: Octokit;
}

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/pulls/{pull_number} — PR metadata
// ---------------------------------------------------------------------------

export interface GithubPullRequestMetadata {
  githubPrId: bigint;
  number: number;
  title: string;
  body: string | null;
  /** null: the author's account can be deleted. */
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  state: "open" | "closed";
  isDraft: boolean;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  htmlUrl: string;
  additions: number;
  deletions: number;
  /** GitHub's `changed_files`. */
  changedFileCount: number;
  githubCreatedAt: Date;
  githubUpdatedAt: Date;
}

interface RawUser {
  login?: string;
  avatar_url?: string;
}

interface RawPullRequestRef {
  ref?: string;
  sha?: string;
}

/** The subset of GitHub's pull request object this code reads. Hand-declared rather than
 * imported from `@octokit/types` — see `installation.github.ts`'s header for why. Every
 * field optional: a 200 missing one is a malformed-body case, not a type error. */
interface RawPullRequest {
  id?: number;
  number?: number;
  title?: string;
  body?: string | null;
  user?: RawUser | null;
  state?: string;
  draft?: boolean;
  base?: RawPullRequestRef;
  head?: RawPullRequestRef;
  html_url?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  created_at?: string;
  updated_at?: string;
}

/**
 * Fetches one pull request's metadata.
 *
 * A malformed 200 (missing `id`, `number`, `head.sha`, or `base.sha`) maps to
 * `{ ok: false, reason: "UNAVAILABLE" }` with a warn — a bug or an upstream change, never
 * a permission state. See `repository.github.ts`'s `getRepository` for the identical
 * reasoning.
 *
 * `githubPrId` stays a real `bigint` (never a string) because it is used for a database
 * write; callers convert it to a string at every JSON boundary.
 */
export async function getPullRequest(
  installationId: bigint,
  owner: string,
  repo: string,
  pullNumber: number,
  options: PullRequestGithubOptions = {},
): Promise<GithubResult<{ pullRequest: GithubPullRequestMetadata }>> {
  const logger = options.logger ?? defaultLogger;
  const octokit =
    options.octokit ?? createInstallationOctokit(installationId, { logger });

  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      { owner, repo, pull_number: pullNumber },
    );
    const metadata = toMetadata(response.data as RawPullRequest);

    if (!metadata) {
      logger.warn(
        "github returned a pull request body this code does not understand",
        {
          installationId: installationId.toString(),
          endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
          fullName: `${owner}/${repo}`,
          pullNumber,
        },
      );
      return { ok: false, reason: "UNAVAILABLE" };
    }

    logger.info("fetched pull request metadata", {
      installationId: installationId.toString(),
      endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      fullName: `${owner}/${repo}`,
      githubPrId: metadata.githubPrId.toString(),
      number: metadata.number,
    });

    return { ok: true, pullRequest: metadata };
  } catch (error) {
    const reason = classifyGithubError(error);
    logger.warn("failed to fetch pull request metadata", {
      installationId: installationId.toString(),
      endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      fullName: `${owner}/${repo}`,
      pullNumber,
      reason,
    });
    return { ok: false, reason };
  }
}

function toMetadata(raw: RawPullRequest): GithubPullRequestMetadata | null {
  const headSha = raw.head?.sha;
  const baseSha = raw.base?.sha;
  if (
    typeof raw.id !== "number" ||
    typeof raw.number !== "number" ||
    typeof headSha !== "string" ||
    typeof baseSha !== "string"
  )
    return null;

  return {
    githubPrId: BigInt(raw.id),
    number: raw.number,
    title: raw.title ?? "",
    body: raw.body ?? null,
    authorLogin: raw.user?.login ?? null,
    authorAvatarUrl: raw.user?.avatar_url ?? null,
    state: raw.state === "closed" ? "closed" : "open",
    isDraft: raw.draft ?? false,
    baseRef: raw.base?.ref ?? "",
    baseSha,
    headRef: raw.head?.ref ?? "",
    headSha,
    htmlUrl: raw.html_url ?? "",
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFileCount: raw.changed_files ?? 0,
    githubCreatedAt: raw.created_at ? new Date(raw.created_at) : new Date(0),
    githubUpdatedAt: raw.updated_at ? new Date(raw.updated_at) : new Date(0),
  };
}

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/pulls?state=open — the open-PR list (Prompt 5's sync source)
// ---------------------------------------------------------------------------

/** Slimmer than {@link GithubPullRequestMetadata}: GitHub's list endpoint does not
 * include `additions`/`deletions`/`changed_files` on its items (only the single-PR fetch
 * does), and Prompt 5's sync endpoint never needs the diff counts anyway. */
export interface GithubPullRequestSummary {
  githubPrId: bigint;
  number: number;
  title: string;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  state: "open" | "closed";
  isDraft: boolean;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  htmlUrl: string;
  githubCreatedAt: Date;
  githubUpdatedAt: Date;
}

function toSummary(raw: RawPullRequest): GithubPullRequestSummary | null {
  const metadata = toMetadata(raw);
  if (!metadata) return null;

  const {
    githubPrId,
    number,
    title,
    authorLogin,
    authorAvatarUrl,
    state,
    isDraft,
    baseRef,
    baseSha,
    headRef,
    headSha,
    htmlUrl,
    githubCreatedAt,
    githubUpdatedAt,
  } = metadata;

  return {
    githubPrId,
    number,
    title,
    authorLogin,
    authorAvatarUrl,
    state,
    isDraft,
    baseRef,
    baseSha,
    headRef,
    headSha,
    htmlUrl,
    githubCreatedAt,
    githubUpdatedAt,
  };
}

const PER_PAGE = 100;

/** Hard ceiling on pagination for the open-PR list, in the style of
 * `installation.github.ts`'s `MAX_PAGES` — so a malformed `Link` header or an endpoint
 * that never reports a short page cannot spin forever inside a job run. At 100 per page
 * this is 5,000 open PRs, far past any repository this product targets. */
export const MAX_OPEN_PR_PAGES = 50;

/**
 * Every open pull request on a repository, fully paginated.
 *
 * Uses the installation token, like every other call in this file — `state=open` is a
 * query filter, not a change of credential.
 */
export async function listOpenPullRequests(
  installationId: bigint,
  owner: string,
  repo: string,
  options: PullRequestGithubOptions = {},
): Promise<GithubResult<{ pullRequests: GithubPullRequestSummary[] }>> {
  const logger = options.logger ?? defaultLogger;
  const octokit =
    options.octokit ?? createInstallationOctokit(installationId, { logger });

  try {
    const pullRequests: GithubPullRequestSummary[] = [];

    for (let page = 1; page <= MAX_OPEN_PR_PAGES; page += 1) {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls",
        { owner, repo, state: "open", per_page: PER_PAGE, page },
      );
      const batch = (response.data as RawPullRequest[] | undefined) ?? [];

      for (const raw of batch) {
        const summary = toSummary(raw);
        if (summary) {
          pullRequests.push(summary);
        } else {
          logger.warn(
            "skipped a pull request entry this code does not understand",
            {
              installationId: installationId.toString(),
              endpoint: "GET /repos/{owner}/{repo}/pulls",
              fullName: `${owner}/${repo}`,
            },
          );
        }
      }

      if (batch.length < PER_PAGE) break;
    }

    logger.info("listed open pull requests", {
      installationId: installationId.toString(),
      endpoint: "GET /repos/{owner}/{repo}/pulls",
      fullName: `${owner}/${repo}`,
      count: pullRequests.length,
    });

    return { ok: true, pullRequests };
  } catch (error) {
    const reason = classifyGithubError(error);
    logger.warn("failed to list open pull requests", {
      installationId: installationId.toString(),
      endpoint: "GET /repos/{owner}/{repo}/pulls",
      fullName: `${owner}/${repo}`,
      reason,
    });
    return { ok: false, reason };
  }
}

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/pulls/{pull_number}/files — paginated changed files
// ---------------------------------------------------------------------------

export interface GithubPullRequestFile {
  /** GitHub's `filename`. */
  path: string;
  /** `previous_filename`, present only on renames. */
  previousPath: string | null;
  status: PullRequestFileStatus;
  additions: number;
  deletions: number;
  changes: number;
  /** Absent for binary files and very large diffs. `null`, never `undefined`, so a
   * consumer has exactly one absence check to make. */
  patch: string | null;
  /** Blob sha at head, when GitHub supplies it. */
  sha: string | null;
}

interface RawPullRequestFile {
  filename?: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
  sha?: string;
}

const KNOWN_FILE_STATUSES: readonly string[] = PULL_REQUEST_FILE_STATUSES;

function normalizeStatus(
  raw: string | undefined,
  logger: Logger,
  context: { installationId: bigint; fullName: string; pullNumber: number },
): PullRequestFileStatus {
  if (raw !== undefined && KNOWN_FILE_STATUSES.includes(raw)) {
    return raw as PullRequestFileStatus;
  }

  logger.warn(
    "github returned an unrecognized file status; defaulting to modified",
    {
      installationId: context.installationId.toString(),
      endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      fullName: context.fullName,
      pullNumber: context.pullNumber,
      status: raw,
    },
  );
  return "modified";
}

/**
 * Every changed file on a pull request, fully paginated up to GitHub's own
 * {@link MAX_FILES_FETCHED} cap.
 *
 * **Deliberately does not stop at 300 files (`MAX_FILES_CONSIDERED`).** GitHub returns
 * files in roughly alphabetical order, not priority order; cutting pagination at the
 * processing cap would silently bias which files get reviewed toward whatever happens to
 * sort early, so a PR's most important file could be dropped purely because its path
 * starts with `z`. This function fetches everything up to the *GitHub-side* 3,000 cap;
 * the 300-file processing cap is applied afterward as an explicit priority-ordered step
 * (Prompt 3), never folded into pagination here. Do not "optimise" this back.
 */
export async function listPullRequestFiles(
  installationId: bigint,
  owner: string,
  repo: string,
  pullNumber: number,
  options: PullRequestGithubOptions = {},
): Promise<GithubResult<{ files: GithubPullRequestFile[]; truncated: boolean }>> {
  const logger = options.logger ?? defaultLogger;
  const octokit =
    options.octokit ?? createInstallationOctokit(installationId, { logger });
  const fullName = `${owner}/${repo}`;

  try {
    const files: GithubPullRequestFile[] = [];
    let truncated = false;

    for (let page = 1; ; page += 1) {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
        { owner, repo, pull_number: pullNumber, per_page: PER_PAGE, page },
      );
      const batch = (response.data as RawPullRequestFile[] | undefined) ?? [];

      for (const raw of batch) {
        if (typeof raw.filename !== "string") {
          logger.warn("skipped a pull request file entry with no filename", {
            installationId: installationId.toString(),
            endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
            fullName,
            pullNumber,
          });
          continue;
        }

        files.push({
          path: raw.filename,
          previousPath:
            raw.status === "renamed" && typeof raw.previous_filename === "string"
              ? raw.previous_filename
              : null,
          status: normalizeStatus(raw.status, logger, {
            installationId,
            fullName,
            pullNumber,
          }),
          additions: raw.additions ?? 0,
          deletions: raw.deletions ?? 0,
          changes: raw.changes ?? 0,
          patch: typeof raw.patch === "string" ? raw.patch : null,
          sha: typeof raw.sha === "string" ? raw.sha : null,
        });
      }

      if (files.length >= MAX_FILES_FETCHED) {
        // GitHub's own hard cap. `truncated` is true only when the last page fetched
        // was itself full — i.e. GitHub had more to give and this call simply stopped,
        // as opposed to the PR happening to have exactly MAX_FILES_FETCHED files.
        truncated = batch.length === PER_PAGE;
        if (files.length > MAX_FILES_FETCHED) files.length = MAX_FILES_FETCHED;
        break;
      }
      if (batch.length < PER_PAGE) break;
    }

    logger.info("fetched pull request changed files", {
      installationId: installationId.toString(),
      endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      fullName,
      pullNumber,
      count: files.length,
      truncated,
    });

    return { ok: true, files, truncated };
  } catch (error) {
    const reason = classifyGithubError(error);
    logger.warn("failed to fetch pull request changed files", {
      installationId: installationId.toString(),
      endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      fullName,
      pullNumber,
      reason,
    });
    return { ok: false, reason };
  }
}
