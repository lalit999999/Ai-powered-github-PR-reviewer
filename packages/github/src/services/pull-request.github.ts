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

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/pulls/{pull_number} (Accept: application/vnd.github.diff) —
// the full-diff fallback for files GitHub omits a `patch` on.
// ---------------------------------------------------------------------------

/**
 * Fetches the whole PR as one raw unified diff string, using the `diff` media type on
 * the same single-PR endpoint {@link getPullRequest} uses.
 */
export async function getPullRequestDiff(
  installationId: bigint,
  owner: string,
  repo: string,
  pullNumber: number,
  options: PullRequestGithubOptions = {},
): Promise<GithubResult<{ diff: string }>> {
  const logger = options.logger ?? defaultLogger;
  const octokit =
    options.octokit ?? createInstallationOctokit(installationId, { logger });
  const fullName = `${owner}/${repo}`;

  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo,
        pull_number: pullNumber,
        headers: { accept: "application/vnd.github.diff" },
      },
    );
    const diff = toDiffString(response.data);

    if (diff === null) {
      logger.warn("github returned a diff body this code does not understand", {
        installationId: installationId.toString(),
        endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number} (diff)",
        fullName,
        pullNumber,
      });
      return { ok: false, reason: "UNAVAILABLE" };
    }

    logger.info("fetched pull request diff", {
      installationId: installationId.toString(),
      endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number} (diff)",
      fullName,
      pullNumber,
      bytes: diff.length,
    });

    return { ok: true, diff };
  } catch (error) {
    const reason = classifyGithubError(error);
    logger.warn("failed to fetch pull request diff", {
      installationId: installationId.toString(),
      endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number} (diff)",
      fullName,
      pullNumber,
      reason,
    });
    return { ok: false, reason };
  }
}

/**
 * Normalizes whatever the installed `@octokit/core` → `@octokit/request` chain actually
 * hands back for a non-JSON response body.
 *
 * Verified by reading the installed `@octokit/request@10.0.15`'s
 * `dist-src/fetch-wrapper.js` (`getResponseData`): a response whose `content-type` has no
 * `charset` parameter and isn't `text/*`/JSON falls through to `response.arrayBuffer()`
 * and arrives as an `ArrayBuffer`; one whose `content-type` carries `charset=utf-8` — which
 * is how GitHub actually sends `application/vnd.github.diff` (`application/vnd.github.diff;
 * charset=utf-8`) — is read with `response.text()` and arrives as a plain `string`. Both
 * are handled (plus a `Buffer` guard, cheap insurance against a future fetch polyfill)
 * so a GitHub content-type change degrades to a decode rather than a crash.
 */
function toDiffString(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return null;
}

// ---------------------------------------------------------------------------
// splitDiffByFile — pure, unit-testable per-file diff splitting
// ---------------------------------------------------------------------------

interface DiffFileSection {
  minusPath: string | null;
  plusPath: string | null;
  plusIsDevNull: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  diffLineOldPath: string | null;
  diffLineNewPath: string | null;
  bodyLines: string[];
  inHunkBody: boolean;
}

function stripAbPrefix(path: string, prefix: "a/" | "b/"): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Best-effort parse of `diff --git a/<old> b/<new>` — used only when neither the
 * `---`/`+++` lines nor `rename from`/`rename to` are present (a mode-only change on an
 * unrenamed file, or a binary file). Paths are assumed identical on both sides, which is
 * true whenever this fallback is actually reached (a real rename always carries
 * `rename from`/`rename to` lines, and content changes always carry `---`/`+++`) — the
 * one gap: an old path that itself contains the literal substring `" b/"` would split in
 * the wrong place. Not reachable from any case this package's own fixtures exercise. */
function parseDiffGitLine(line: string): {
  oldPath: string | null;
  newPath: string | null;
} {
  const rest = line.slice("diff --git ".length);
  if (!rest.startsWith("a/")) return { oldPath: null, newPath: null };

  const withoutAPrefix = rest.slice(2);
  const bMarker = " b/";
  const bIndex = withoutAPrefix.indexOf(bMarker);
  if (bIndex === -1) return { oldPath: null, newPath: null };

  return {
    oldPath: withoutAPrefix.slice(0, bIndex),
    newPath: withoutAPrefix.slice(bIndex + bMarker.length),
  };
}

function resolveFileKey(section: DiffFileSection): string | null {
  // A deletion's "+++" line is "+++ /dev/null" — key on the old (a/) path.
  if (section.plusIsDevNull) {
    return section.minusPath ?? section.renameFrom ?? section.diffLineOldPath;
  }
  // Everything else (added/modified/renamed/copied) — key on the new (b/) path, which
  // is what listPullRequestFiles reports as `filename`.
  return section.plusPath ?? section.renameTo ?? section.diffLineNewPath;
}

/**
 * Splits a whole-PR unified diff into `Map<path, patch>`, one entry per file, where each
 * `patch` is exactly the per-file body GitHub would have put in that file's `patch`
 * field: the hunks starting at the first `@@`, without the `diff --git`, `index`, `---`,
 * `+++`, `similarity index`, `rename from/to`, or `new file mode` header lines.
 *
 * An explicit line-by-line state machine, not a whole-document regex: a diff can contain
 * lines that *look* like header lines inside a hunk body (e.g. a file documenting git
 * output has a content line reading `diff --git a/x b/x`), and only line position plus
 * leading-character prefix disambiguates them. Content lines always carry a leading
 * marker character (`+`, `-`, ` `, or `\`) — a genuine header line never does — so
 * checking the raw line's prefix at column 0, before any marker is stripped, is enough.
 */
export function splitDiffByFile(diff: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!diff) return result;

  const normalized = diff.endsWith("\n") ? diff.slice(0, -1) : diff;
  const lines = normalized.split("\n");

  let current: DiffFileSection | null = null;

  const flush = () => {
    if (!current) return;
    const key = resolveFileKey(current);
    if (key !== null) result.set(key, current.bodyLines.join("\n"));
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const { oldPath, newPath } = parseDiffGitLine(line);
      current = {
        minusPath: null,
        plusPath: null,
        plusIsDevNull: false,
        renameFrom: null,
        renameTo: null,
        diffLineOldPath: oldPath,
        diffLineNewPath: newPath,
        bodyLines: [],
        inHunkBody: false,
      };
      continue;
    }

    if (!current) continue; // content before any "diff --git" line — nothing to attribute it to

    if (current.inHunkBody) {
      current.bodyLines.push(line);
      continue;
    }

    // Header zone for the current file: not yet inside a hunk body.
    if (line.startsWith("@@")) {
      current.inHunkBody = true;
      current.bodyLines.push(line);
      continue;
    }
    if (line.startsWith("--- ")) {
      const path = line.slice(4);
      if (path !== "/dev/null") current.minusPath = stripAbPrefix(path, "a/");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      if (path === "/dev/null") current.plusIsDevNull = true;
      else current.plusPath = stripAbPrefix(path, "b/");
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.renameFrom = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.renameTo = line.slice("rename to ".length);
      continue;
    }
    // "index ...", "similarity index ...", "old/new mode ...", "copy from/to ...",
    // "new/deleted file mode ...", "Binary files ... differ": header-zone lines that
    // are never part of a file's patch body — skipped.
  }

  flush();
  return result;
}

// ---------------------------------------------------------------------------
// fetchPatchesForMissing — ties listPullRequestFiles and the full-diff fallback together
// ---------------------------------------------------------------------------

/**
 * Fills in `patch` for every file where GitHub omitted it, using ONE whole-PR diff call
 * for the entire set — never one call per file. Returns the files unchanged, and
 * `fallbackUsed` so the caller can log/assert that the fallback fired only when it was
 * actually needed. If the fallback call itself fails, the files are returned with their
 * patches still null: a review with an incomplete position map is far better than no
 * review, and the null patch is already a fully-handled case everywhere downstream.
 */
export async function fetchPatchesForMissing(
  installationId: bigint,
  owner: string,
  repo: string,
  pullNumber: number,
  files: GithubPullRequestFile[],
  options: PullRequestGithubOptions = {},
): Promise<{
  files: GithubPullRequestFile[];
  fallbackUsed: boolean;
  fallbackFailed: boolean;
}> {
  const missing = files.filter((file) => file.patch === null);
  if (missing.length === 0) {
    return { files, fallbackUsed: false, fallbackFailed: false };
  }

  const logger = options.logger ?? defaultLogger;
  const fullName = `${owner}/${repo}`;

  const diffResult = await getPullRequestDiff(
    installationId,
    owner,
    repo,
    pullNumber,
    options,
  );

  if (!diffResult.ok) {
    logger.warn("full-diff fallback failed; leaving missing patches null", {
      installationId: installationId.toString(),
      fullName,
      pullNumber,
      missingCount: missing.length,
      reason: diffResult.reason,
    });
    return { files, fallbackUsed: true, fallbackFailed: true };
  }

  logger.info("full-diff fallback fired for files missing a patch", {
    installationId: installationId.toString(),
    fullName,
    pullNumber,
    missingCount: missing.length,
  });

  const perFile = splitDiffByFile(diffResult.diff);
  const filledFiles = files.map((file) => {
    if (file.patch !== null) return file;
    const patch = perFile.get(file.path);
    return patch !== undefined ? { ...file, patch } : file;
  });

  return { files: filledFiles, fallbackUsed: true, fallbackFailed: false };
}
