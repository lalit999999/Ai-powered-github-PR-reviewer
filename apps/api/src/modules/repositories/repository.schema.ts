import { z } from "zod";

/**
 * Every repositories/github route parses its input through these, via `parseOrThrow`
 * (src/lib/validation.ts) — no handler touches `req.body`/`req.query`/`req.params`
 * directly (Architecture Rules, phase-00 §7).
 *
 * The centrepiece is {@link parseGithubRepoUrl}: phase-02 §13 makes it the system's
 * **first SSRF control**, and states that the same validator is *reused, never
 * reimplemented,* by every later phase that handles a user-supplied GitHub URL
 * (Phase 07/08's context-fetching paths are the named consumers). Everything else in
 * this file is ordinary shape validation.
 */

// ---------------------------------------------------------------------------
// GitHub repository URL — the allow-list validator (phase-02 §13, plan.md §35.9)
// ---------------------------------------------------------------------------

/**
 * The **allow-list**. A GitHub Enterprise Server deployment is added here, in this one
 * place, and nowhere else — that is the entire reason this is a named set rather than
 * an inline comparison.
 *
 * `www.github.com` is deliberately absent: it is a redirect, not an API host, and
 * every URL a user can copy out of GitHub's own UI is bare `github.com`. Adding hosts
 * "just in case" is how an allow-list stops being one.
 *
 * Compared against `URL.hostname`, which the WHATWG parser has already lowercased and
 * IDNA-normalized, so `GitHub.COM` and its punycode spellings match without a second
 * normalization pass here.
 */
export const GITHUB_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
]);

/**
 * Hard length ceiling applied **before** the URL parser runs. GitHub's own limits are
 * 39 characters for an owner and 100 for a repository name, so a legitimate URL is
 * under ~165 characters; 512 leaves generous room for a pasted `.git` suffix or a
 * tracking query string while keeping a multi-megabyte paste from ever reaching the
 * parser. Cheap guard first, expensive parse second.
 */
export const MAX_REPO_URL_LENGTH = 512;

/**
 * GitHub owner (user or org) names: alphanumeric and hyphens, not starting with a
 * hyphen. Repository names additionally allow `.` and `_`.
 *
 * These run **after** `new URL()` has parsed the input, never instead of it. Regex-only
 * URL "validation" is how SSRF bugs get shipped — a pattern that looks like it anchors
 * the host is trivially defeated by `https://github.com.evil.com/…` or
 * `https://user@evil.com/github.com/o/r`. The parser decides scheme/host/port/userinfo;
 * these two patterns only constrain the two path segments the parser handed back.
 */
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Why a candidate URL was rejected. Machine-readable, for logs and tests — the
 * user-visible message is always {@link GITHUB_REPO_URL_MESSAGE}, because telling a
 * caller *which* of these tripped is a fingerprinting aid and not actionable. */
export type GithubRepoUrlRejection =
  | "TOO_LONG"
  | "NOT_A_URL"
  | "BAD_SCHEME"
  | "HOST_NOT_ALLOWED"
  | "USERINFO_PRESENT"
  | "PORT_NOT_ALLOWED"
  | "BAD_PATH";

/** A repository named the way GitHub's API names it: `{owner}/{repo}`. */
export interface GithubRepoRef {
  owner: string;
  repo: string;
}

export type GithubRepoUrlResult =
  | ({ ok: true } & GithubRepoRef)
  | { ok: false; reason: GithubRepoUrlRejection };

/** phase-02 §12's exact wording for the invalid-URL case. */
export const GITHUB_REPO_URL_MESSAGE =
  "That doesn't look like a GitHub repository URL";

/**
 * Parses a user-supplied GitHub repository URL under an allow-list, returning the
 * `{ owner, repo }` pair it names.
 *
 * **It returns the parsed pair rather than a boolean on purpose.** A validator that
 * answers `true` invites its caller to extract owner/repo with a second, subtly
 * different parse — and the second parse is the one that gets it wrong. Callers take
 * the pair from here or they do not get one.
 *
 * What is rejected, and why each one is on the list:
 *
 * | Input | Rejected because |
 * |---|---|
 * | `http://github.com/o/r` | not TLS; a downgrade is never accepted |
 * | `https://github.com.evil.com/o/r` | attacker-controlled host that *contains* the allowed one |
 * | `https://evil.com/github.com/o/r` | allowed host appearing in the path |
 * | `https://user:pass@github.com/o/r` | userinfo — the classic parser-confusion payload |
 * | `https://github.com:8080/o/r` | non-default port |
 * | `https://github.com/o` / `…/o/r/tree/main` | not exactly two path segments |
 * | `https://github.com/o/../../etc` | `..` — normalized away by the parser, then caught by the segment count |
 * | `//github.com/o/r` | scheme-relative: no base, so it is not a URL at all |
 *
 * Normalization applied to an accepted URL: a trailing `.git` is stripped, trailing
 * slashes are stripped, and query strings and fragments are discarded (they are simply
 * never read — only `pathname` is).
 *
 * **Case is preserved, not lowercased.** GitHub lookups are case-insensitive, but the
 * canonical casing belongs to the API's response, and that is what gets stored — so
 * lowercasing here would only create a second, wrong spelling to reconcile later. This
 * value is used to *address* the API call; `GET /repos/{o}/{r}`'s response is the
 * source of truth for what is written to the database.
 */
export function parseGithubRepoUrl(input: string): GithubRepoUrlResult {
  // Cheap guards before the parser. `.trim()` because a pasted URL routinely carries
  // surrounding whitespace, and rejecting that would be hostile for no security gain.
  const candidate = input.trim();
  if (candidate.length === 0 || candidate.length > MAX_REPO_URL_LENGTH) {
    return {
      ok: false,
      reason: candidate.length === 0 ? "NOT_A_URL" : "TOO_LONG",
    };
  }

  let url: URL;
  try {
    // No base argument: a scheme-relative or relative input must fail here rather than
    // being resolved against something.
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "NOT_A_URL" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: "BAD_SCHEME" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "USERINFO_PRESENT" };
  }
  // The WHATWG parser leaves `port` empty for a scheme's default, so this rejects an
  // explicit `:8080` while still accepting a redundant `:443`.
  if (url.port !== "") {
    return { ok: false, reason: "PORT_NOT_ALLOWED" };
  }
  if (!GITHUB_ALLOWED_HOSTS.has(url.hostname)) {
    return { ok: false, reason: "HOST_NOT_ALLOWED" };
  }

  // Only `pathname` is read, which is how query strings and fragments get discarded.
  // Trailing slashes are stripped; interior empty segments are NOT tolerated (splitting
  // and filtering empties would quietly accept `github.com/o//r`).
  const segments = url.pathname.replace(/\/+$/, "").split("/");
  if (segments.length !== 3 || segments[0] !== "") {
    return { ok: false, reason: "BAD_PATH" };
  }

  const owner = segments[1] ?? "";
  const repo = stripGitSuffix(segments[2] ?? "");

  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) {
    return { ok: false, reason: "BAD_PATH" };
  }

  return { ok: true, owner, repo };
}

/** `https://github.com/o/r.git` is what `git clone` hands you, and it names the same
 * repository. A repository legitimately named `foo.git` is not addressable this way on
 * GitHub either, so nothing is lost. */
function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

/**
 * The Zod face of {@link parseGithubRepoUrl}, for any caller that validates through
 * `parseOrThrow`. Transforms to the `{ owner, repo }` pair so a schema-validated URL
 * never has to be re-parsed downstream.
 *
 * Exported as this phase's reuse point per §13 ("reused, never reimplemented"). The
 * connect body below deliberately keeps `repoUrl` as a *string* instead of using this
 * — see its comment.
 */
export const githubRepoUrlSchema: z.ZodType<GithubRepoRef, string> = z
  .string()
  .transform((value, ctx): GithubRepoRef => {
    const result = parseGithubRepoUrl(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: GITHUB_REPO_URL_MESSAGE });
      return z.NEVER;
    }
    return { owner: result.owner, repo: result.repo };
  });

// ---------------------------------------------------------------------------
// Request bodies, params, and queries
// ---------------------------------------------------------------------------

/**
 * A GitHub repository id as it arrives over the wire.
 *
 * **It is a string, and a JS `number` is rejected outright.** JSON has no bigint, so a
 * client cannot send one; accepting a `number` instead would silently round any id past
 * `Number.MAX_SAFE_INTEGER` (2^53−1) to a *different, valid-looking* id — a rare,
 * nasty, and effectively undebuggable bug. GitHub's ids are int64 and are not near that
 * boundary today, which is exactly why this has to be decided now rather than
 * discovered later.
 *
 * `^[1-9][0-9]{0,18}$` rejects the empty string, a leading `+`/`-` (so negatives are
 * out), a leading zero, and anything non-numeric, and bounds the value below int64's
 * maximum without a second range check.
 */
const GITHUB_REPO_ID_PATTERN = /^[1-9][0-9]{0,18}$/;

export const githubIdSchema: z.ZodType<bigint, string> = z
  .string()
  .regex(GITHUB_REPO_ID_PATTERN, "Must be a positive GitHub id")
  .transform((value) => BigInt(value));

/**
 * `POST /api/projects/:projectId/repositories` body (phase-02 §7).
 *
 * **Exactly one of `repoUrl` / `githubRepoId`.** Both-or-neither is a 400 with a
 * field-level message, not a silent preference for one: "the picker sent an id AND a
 * URL" means the two halves of the client disagree about what the user selected, and
 * quietly picking a winner would connect a repository the user did not choose.
 *
 * `repoUrl` stays a **string** here rather than using `githubRepoUrlSchema`'s
 * transform, so the service's input type is the honest wire shape ("a URL or an id")
 * and step 1 of §3's validation chain lives *in* the chain
 * (`repository-validation.service`) instead of being smeared across the HTTP boundary.
 * The URL is still rejected here with the same message and the same parser, so a bad
 * URL never reaches the service — the service's own check is defence in depth for
 * callers that do not arrive over HTTP.
 */
export const connectRepositoryBodySchema = z
  .object({
    repoUrl: z.string().max(MAX_REPO_URL_LENGTH).optional(),
    githubRepoId: githubIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const provided = [
      value.repoUrl !== undefined,
      value.githubRepoId !== undefined,
    ].filter(Boolean).length;

    if (provided !== 1) {
      const message =
        provided === 0
          ? "Provide either repoUrl or githubRepoId"
          : "Provide exactly one of repoUrl or githubRepoId, not both";
      // Reported on both fields so a form highlights whichever the user is looking at.
      ctx.addIssue({ code: "custom", message, path: ["repoUrl"] });
      ctx.addIssue({ code: "custom", message, path: ["githubRepoId"] });
      return;
    }

    if (value.repoUrl !== undefined && !parseGithubRepoUrl(value.repoUrl).ok) {
      ctx.addIssue({
        code: "custom",
        message: GITHUB_REPO_URL_MESSAGE,
        path: ["repoUrl"],
      });
    }
  });

/**
 * Route params. Only "non-empty string" is asserted, following `project.schema.ts`'s
 * precedent and for the same reason: `Repository.id` is a `TEXT` column, so a malformed
 * id is simply a value matching no row, and letting it fall through to
 * `requireTenantAccess` renders it as 404 like any other unresolvable id. Asserting a
 * UUID shape here would answer "that id could not possibly exist" — a shape oracle the
 * 404-for-everything policy (phase-01-log §16) otherwise denies the caller.
 */
export const repositoryIdParamSchema = z.object({
  repositoryId: z.string().min(1),
});

/**
 * `GET /api/github/installations/:installationId/repos` param.
 *
 * Unlike a repository id this **is** validated for shape, because it is a GitHub-global
 * `BigInt` rather than an opaque local id: a non-numeric value cannot name any
 * installation at all, and it has to become a `bigint` before it can be compared to the
 * `GithubInstallation.installationId` column. There is no oracle here — the ownership
 * check that follows is what decides, and it answers 403 for every id the caller does
 * not own, existing or not (see github.controller.ts for why 403 rather than 404).
 */
export const installationIdParamSchema = z.object({
  installationId: githubIdSchema,
});

/** Bounded so a pathological `?q` never reaches GitHub or a `contains` filter. */
export const REPO_SEARCH_QUERY_MAX_LENGTH = 100;

/** The picker's search filter. Trimmed, bounded, and optional; an empty or
 * whitespace-only `q` means "no filter" rather than "match nothing". */
export const listInstallationReposQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(
      REPO_SEARCH_QUERY_MAX_LENGTH,
      `q must be at most ${REPO_SEARCH_QUERY_MAX_LENGTH} characters`,
    )
    .optional()
    .transform((value) =>
      value !== undefined && value.length > 0 ? value : undefined,
    ),
});

/**
 * `POST /api/repositories/:id/index` body (phase-03 §7).
 *
 * `"INCREMENTAL"` is accepted by the schema — the client can send it and get a real,
 * field-level validation error back, rather than the request never having named it as a
 * legal value at all — but is rejected with 400 until Phase 14 implements it (`plan.md`
 * §2.1/§47). This is an explicit, tested branch (`repository.schema.test.ts`), not an
 * accident of `z.literal("FULL")` happening to reject everything else.
 */
export const INCREMENTAL_NOT_SUPPORTED_MESSAGE =
  'Incremental indexing is not yet supported — use mode: "FULL"';

export const triggerIndexBodySchema = z
  .object({
    mode: z.enum(
      ["FULL", "INCREMENTAL"],
      'mode must be "FULL" or "INCREMENTAL"',
    ),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "INCREMENTAL") {
      ctx.addIssue({
        code: "custom",
        message: INCREMENTAL_NOT_SUPPORTED_MESSAGE,
        path: ["mode"],
      });
    }
  });

export type ConnectRepositoryBody = z.infer<typeof connectRepositoryBodySchema>;
export type RepositoryIdParam = z.infer<typeof repositoryIdParamSchema>;
export type InstallationIdParam = z.infer<typeof installationIdParamSchema>;
export type ListInstallationReposQuery = z.infer<
  typeof listInstallationReposQuerySchema
>;
export type TriggerIndexBody = z.infer<typeof triggerIndexBodySchema>;
