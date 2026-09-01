/**
 * Public surface of @repo/github. Everything a consuming app (apps/api, apps/worker)
 * needs; internals (rate-limiter constants, the etag/token-cache implementations, the
 * private-key parsing internals) stay reachable only by relative import *within* this
 * package. See docs/decisions/phase-03-log.md, sub-task 1.1, for the package's history.
 */

// ---------------------------------------------------------------------------
// Boot-time configuration — call initGithubClient() once, before anything else here.
// ---------------------------------------------------------------------------
export {
  getGithubClientConfig,
  githubAppPrivateKeySchema,
  githubRedisUrlSchema,
  initGithubClient,
  resetGithubClientConfigForTesting,
  type GithubClientConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// Errors — reuse these, never construct a parallel taxonomy for the same failures.
// ---------------------------------------------------------------------------
export {
  GithubAccessRevokedError,
  GithubClientError,
  GithubRateLimitError,
  ServiceUnavailableError,
  type GithubClientErrorOptions,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Token minting and the Octokit factory — the only sanctioned way to reach GitHub.
// ---------------------------------------------------------------------------
export {
  getInstallationToken,
  invalidateInstallationToken,
  type GithubHttpClient,
} from "./client/app-auth.js";
export {
  createInstallationOctokit,
  createUserOctokit,
  GITHUB_CLIENT_COMPONENT,
  type OctokitFactoryOptions,
  type UserOctokitOptions,
} from "./client/octokit-factory.js";

// ---------------------------------------------------------------------------
// The typed-result vocabulary every service wrapper below returns.
// ---------------------------------------------------------------------------
export {
  classifyGithubError,
  hasRateLimitHeaders,
  statusOf,
  type GithubFailureReason,
  type GithubResult,
} from "./services/github-result.js";

// ---------------------------------------------------------------------------
// Endpoint wrappers, grouped by the credential they use (see installation.github.ts's
// header for why that grouping matters). Kept as namespaces so existing call sites
// (`repositoryGithub.getRepository(...)`) needed no rewrite beyond the import source —
// see the decision log for why that minimal-diff shape was chosen.
// ---------------------------------------------------------------------------
export * as installationGithub from "./services/installation.github.js";
export * as repositoryGithub from "./services/repository.github.js";
export * as pullRequestGithub from "./services/pull-request.github.js";

// Also named directly — repository-validation.service.ts (apps/api) references these
// as bare types throughout, and re-deriving every reference through the namespace above
// would be exactly the kind of unrelated rewrite sub-task 1.1 asked to avoid.
export type {
  BranchProbeResult,
  GithubRepositoryMetadata,
  HeadCommit,
} from "./services/repository.github.js";
export type {
  GithubInstallationSummary,
  InstallationRepositorySummary,
} from "./services/installation.github.js";
export type {
  GithubPullRequestFile,
  GithubPullRequestMetadata,
  GithubPullRequestSummary,
  PullRequestGithubOptions,
} from "./services/pull-request.github.js";
