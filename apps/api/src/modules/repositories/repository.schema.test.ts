import { describe, expect, it } from "vitest";
import {
  GITHUB_REPO_URL_MESSAGE,
  INCREMENTAL_NOT_SUPPORTED_MESSAGE,
  MAX_REPO_URL_LENGTH,
  connectRepositoryBodySchema,
  githubRepoUrlSchema,
  installationIdParamSchema,
  listInstallationReposQuerySchema,
  parseGithubRepoUrl,
  repositoryIdParamSchema,
  triggerIndexBodySchema,
  type GithubRepoUrlRejection,
} from "./repository.schema.js";

/**
 * phase-02 §13 makes this validator the system's first SSRF control and says every
 * later phase reuses it rather than writing its own. The rejection table below is
 * deliberately adversarial: each row is a payload that a regex-only "validator" (the
 * thing §13 exists to prevent) would wave through.
 */

describe("parseGithubRepoUrl — accepted forms (phase-02 §13)", () => {
  it("accepts the canonical form and returns the parsed pair, not a boolean", () => {
    expect(parseGithubRepoUrl("https://github.com/octocat/hello-world")).toEqual({
      ok: true,
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it.each([
    ["https://github.com/octocat/hello-world.git", "the clone URL's .git suffix is stripped"],
    ["https://github.com/octocat/hello-world/", "a trailing slash is stripped"],
    ["https://github.com/octocat/hello-world///", "repeated trailing slashes are stripped"],
    ["https://github.com/octocat/hello-world?tab=readme", "a query string is discarded"],
    ["https://github.com/octocat/hello-world#readme", "a fragment is discarded"],
    ["  https://github.com/octocat/hello-world  ", "surrounding whitespace from a paste is trimmed"],
    ["https://github.com:443/octocat/hello-world", "https's default port is not an explicit port"],
  ])("normalizes %j — %s", (input) => {
    expect(parseGithubRepoUrl(input)).toEqual({ ok: true, owner: "octocat", repo: "hello-world" });
  });

  it("preserves the case the user typed rather than lowercasing it", () => {
    // GitHub lookups are case-insensitive; the canonical casing comes back from the
    // API response and is what gets stored. Lowercasing here would invent a second,
    // wrong spelling to reconcile later.
    expect(parseGithubRepoUrl("https://github.com/OctoCat/Hello-World")).toEqual({
      ok: true,
      owner: "OctoCat",
      repo: "Hello-World",
    });
  });

  it("accepts a repository name containing dots and underscores", () => {
    expect(parseGithubRepoUrl("https://github.com/acme/my_repo.v2")).toEqual({
      ok: true,
      owner: "acme",
      repo: "my_repo.v2",
    });
  });
});

describe("parseGithubRepoUrl — rejections (the SSRF table)", () => {
  const cases: Array<[string, GithubRepoUrlRejection, string]> = [
    ["http://github.com/o/r", "BAD_SCHEME", "a TLS downgrade is never accepted"],
    ["ftp://github.com/o/r", "BAD_SCHEME", "no other scheme is either"],
    ["javascript:alert(1)//github.com/o/r", "BAD_SCHEME", "a script URL that mentions the host"],
    ["https://github.com.evil.com/o/r", "HOST_NOT_ALLOWED", "attacker host CONTAINING the allowed one"],
    ["https://evil.com/github.com/o/r", "HOST_NOT_ALLOWED", "allowed host appearing in the path"],
    ["https://githubXcom/o/r", "HOST_NOT_ALLOWED", "an unescaped dot in a naive regex matches this"],
    ["https://user:pass@github.com/o/r", "USERINFO_PRESENT", "the classic parser-confusion payload"],
    ["https://github.com@evil.com/o/r", "USERINFO_PRESENT", "allowed host as the userinfo of another"],
    ["https://github.com:8080/o/r", "PORT_NOT_ALLOWED", "a non-default port"],
    ["https://github.com/o", "BAD_PATH", "one path segment is not a repository"],
    ["https://github.com/", "BAD_PATH", "no path segments at all"],
    ["https://github.com/o/r/tree/main", "BAD_PATH", "extra segments beyond owner/repo"],
    ["https://github.com/o/../../etc", "BAD_PATH", "dot-dot segments"],
    ["https://github.com/o//r", "BAD_PATH", "an interior empty segment"],
    ["https://github.com/o/%2e%2e", "BAD_PATH", "percent-encoded dot-dot"],
    ["https://github.com/-bad/r", "BAD_PATH", "an owner may not start with a hyphen"],
    ["//github.com/o/r", "NOT_A_URL", "scheme-relative — not a URL without a base"],
    ["github.com/o/r", "NOT_A_URL", "bare host, no scheme"],
    ["/o/r", "NOT_A_URL", "a relative path"],
    ["", "NOT_A_URL", "the empty string"],
    ["   ", "NOT_A_URL", "whitespace only"],
    ["not a url at all", "NOT_A_URL", "free text"],
  ];

  it.each(cases)("rejects %j as %s — %s", (input, reason) => {
    expect(parseGithubRepoUrl(input)).toEqual({ ok: false, reason });
  });

  it("rejects a 10KB string on length before it ever reaches the URL parser", () => {
    const huge = `https://github.com/octocat/${"a".repeat(10_000)}`;
    expect(huge.length).toBeGreaterThan(MAX_REPO_URL_LENGTH);
    expect(parseGithubRepoUrl(huge)).toEqual({ ok: false, reason: "TOO_LONG" });
  });

  it("rejects an over-long string even when it is not a URL at all", () => {
    expect(parseGithubRepoUrl("x".repeat(10_000))).toEqual({ ok: false, reason: "TOO_LONG" });
  });
});

describe("githubRepoUrlSchema — the Zod face of the same parser", () => {
  it("transforms an accepted URL into the parsed pair", () => {
    expect(githubRepoUrlSchema.parse("https://github.com/octocat/hello-world.git")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("reports one message for every rejection reason, never which one tripped", () => {
    // Telling the caller *which* check failed is a fingerprinting aid and is not
    // actionable — the machine-readable reason stays in parseGithubRepoUrl's result,
    // for logs and for this test file.
    for (const input of ["http://github.com/o/r", "https://github.com.evil.com/o/r", "https://github.com/o"]) {
      const result = githubRepoUrlSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(GITHUB_REPO_URL_MESSAGE);
    }
  });
});

describe("connectRepositoryBodySchema — exactly one of repoUrl / githubRepoId (phase-02 §7)", () => {
  it("accepts a URL alone", () => {
    expect(connectRepositoryBodySchema.parse({ repoUrl: "https://github.com/octocat/hello-world" })).toEqual({
      repoUrl: "https://github.com/octocat/hello-world",
    });
  });

  it("accepts an id alone and coerces it to a bigint", () => {
    const parsed = connectRepositoryBodySchema.parse({ githubRepoId: "1296269" });
    expect(parsed.githubRepoId).toBe(1296269n);
    expect(typeof parsed.githubRepoId).toBe("bigint");
  });

  it("rejects neither, with a field-level message on both fields", () => {
    const result = connectRepositoryBodySchema.safeParse({});
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0]).sort()).toEqual(["githubRepoId", "repoUrl"]);
    expect(result.error?.issues[0]?.message).toBe("Provide either repoUrl or githubRepoId");
  });

  it("rejects both — it never silently prefers one", () => {
    // Both present means the two halves of the client disagree about what the user
    // selected; picking a winner would connect a repository nobody chose.
    const result = connectRepositoryBodySchema.safeParse({
      repoUrl: "https://github.com/octocat/hello-world",
      githubRepoId: "1296269",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Provide exactly one of repoUrl or githubRepoId, not both");
  });

  it("rejects a bad URL with the actionable message before the service ever sees it", () => {
    const result = connectRepositoryBodySchema.safeParse({ repoUrl: "https://github.com.evil.com/o/r" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(GITHUB_REPO_URL_MESSAGE);
  });

  it("rejects a JSON number for githubRepoId rather than losing precision", () => {
    // 2^53 is where a JS number stops being able to represent consecutive integers.
    // Accepting a number would round a large id to a different, valid-looking one.
    expect(connectRepositoryBodySchema.safeParse({ githubRepoId: 1296269 }).success).toBe(false);
    // Written as an expression, not a literal: the literal itself cannot be spelled
    // in source without already having lost the precision this test is about.
    expect(connectRepositoryBodySchema.safeParse({ githubRepoId: Number.MAX_SAFE_INTEGER + 2 }).success).toBe(
      false,
    );
  });

  it.each([["0"], ["-1"], ["01"], ["1.5"], ["1e5"], ["12abc"], [""], ["99999999999999999999"]])(
    "rejects %j as a githubRepoId",
    (value) => {
      expect(connectRepositoryBodySchema.safeParse({ githubRepoId: value }).success).toBe(false);
    },
  );

  it("accepts an id at int64's practical upper end without precision loss", () => {
    const parsed = connectRepositoryBodySchema.parse({ githubRepoId: "9223372036854775807" });
    expect(parsed.githubRepoId).toBe(9223372036854775807n);
  });
});

describe("params and query schemas", () => {
  it("accepts any non-empty repositoryId, so a malformed id 404s rather than 400s", () => {
    // Deliberately not a UUID assertion — see the schema's doc comment.
    expect(repositoryIdParamSchema.parse({ repositoryId: "not-a-uuid" })).toEqual({ repositoryId: "not-a-uuid" });
    expect(repositoryIdParamSchema.safeParse({ repositoryId: "" }).success).toBe(false);
  });

  it("coerces installationId to a bigint and rejects a non-numeric one", () => {
    expect(installationIdParamSchema.parse({ installationId: "42" })).toEqual({ installationId: 42n });
    expect(installationIdParamSchema.safeParse({ installationId: "abc" }).success).toBe(false);
  });

  it("treats an empty or whitespace-only ?q as no filter", () => {
    expect(listInstallationReposQuerySchema.parse({})).toEqual({ q: undefined });
    expect(listInstallationReposQuerySchema.parse({ q: "   " })).toEqual({ q: undefined });
    expect(listInstallationReposQuerySchema.parse({ q: "  api  " })).toEqual({ q: "api" });
  });

  it("rejects an over-long ?q", () => {
    expect(listInstallationReposQuerySchema.safeParse({ q: "a".repeat(101) }).success).toBe(false);
  });
});

/**
 * phase-03 §7: `"INCREMENTAL"` must be a **named, explicit** 400 — the schema
 * recognizes it as a legal enum value, not merely "not FULL" — so it is rejected with
 * a specific, actionable message rather than an accidental catch-all rejection that
 * would just as happily reject a typo.
 */
describe("triggerIndexBodySchema — INCREMENTAL is explicitly rejected, not merely absent (§7)", () => {
  it("accepts mode: FULL", () => {
    expect(triggerIndexBodySchema.safeParse({ mode: "FULL" }).success).toBe(true);
  });

  it("rejects mode: INCREMENTAL with the specific not-yet-supported message", () => {
    const result = triggerIndexBodySchema.safeParse({ mode: "INCREMENTAL" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message === INCREMENTAL_NOT_SUPPORTED_MESSAGE)).toBe(true);
    }
  });

  it("rejects a mode that is neither FULL nor INCREMENTAL", () => {
    expect(triggerIndexBodySchema.safeParse({ mode: "PARTIAL" }).success).toBe(false);
  });

  it("rejects a missing mode", () => {
    expect(triggerIndexBodySchema.safeParse({}).success).toBe(false);
  });
});
