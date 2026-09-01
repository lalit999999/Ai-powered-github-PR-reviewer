import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/core";
import {
  fetchPatchesForMissing,
  getPullRequest,
  getPullRequestDiff,
  listOpenPullRequests,
  listPullRequestFiles,
  splitDiffByFile,
  type GithubPullRequestFile,
} from "./pull-request.github.js";

/**
 * Sub-task 2.4. Follows `github-services.test.ts`'s stub-Octokit convention (a fast,
 * seam-injection style, distinct from `github-fixtures.test.ts`'s real-HTTP/nock suite)
 * — this file lives alongside `github-services.test.ts` rather than extending it because
 * the pull-request surface is large enough (five exports, plus the pure `splitDiffByFile`)
 * to warrant its own file, matching how `repository.github.ts`/`installation.github.ts`
 * each got their own fixture set even though both are exercised from the same
 * `github-services.test.ts` today — a new endpoint family, a new file.
 */

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tests/fixtures/github",
);

interface FixtureFile {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function loadFixtureBody(name: string): unknown {
  const raw = readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf8");
  return (JSON.parse(raw) as FixtureFile).body;
}

function loadDiffFixture(): string {
  return readFileSync(path.join(FIXTURES_DIR, "pull-request-diff.txt"), "utf8");
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const INSTALLATION_ID = 58234971n;

/** Same stub shape as `github-services.test.ts` — a fake standing in for the one method
 * every wrapper here uses, cast at the boundary so tests never construct a real Octokit. */
function stubOctokit(
  request: (route: string, params?: Record<string, unknown>) => unknown,
): Octokit {
  return { request: vi.fn(request) } as unknown as Octokit;
}

function githubError(status: number): Error & { status: number } {
  const error = new Error(`HTTP ${status}`) as Error & { status: number };
  error.status = status;
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getPullRequest
// ---------------------------------------------------------------------------

describe("getPullRequest", () => {
  it("maps every field correctly, including githubPrId as a bigint and both timestamps as real Dates", async () => {
    const octokit = stubOctokit(() => ({ data: loadFixtureBody("pull-request-open") }));

    const result = await getPullRequest(INSTALLATION_ID, "acme-corp", "service-1", 42, {
      octokit,
      logger,
    });

    expect(result).toEqual({
      ok: true,
      pullRequest: {
        githubPrId: 1935423293n,
        number: 42,
        title: "Add pagination guard to the changed-files fetch",
        body: "This adds a MAX_FILES_FETCHED ceiling so an oversized PR cannot spin the\nfiles fetch forever.\n\nCloses #41",
        authorLogin: "octocat",
        authorAvatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
        state: "open",
        isDraft: false,
        baseRef: "main",
        baseSha: "6dcb09b5b57875f334f61aebed695e2e4193db5",
        headRef: "octocat/pagination-guard",
        headSha: "34c5c7793cb491521132c1e8e94c07b4e5aa9c5c",
        htmlUrl: "https://github.com/acme-corp/service-1/pull/42",
        additions: 254,
        deletions: 47,
        changedFileCount: 6,
        githubCreatedAt: new Date("2026-08-20T14:03:11Z"),
        githubUpdatedAt: new Date("2026-08-21T09:12:44Z"),
      },
    });
    expect(result.ok && result.pullRequest.githubCreatedAt).toBeInstanceOf(Date);
    expect(result.ok && result.pullRequest.githubUpdatedAt).toBeInstanceOf(Date);
  });

  it("returns NOT_ACCESSIBLE for a 404, no throw", async () => {
    const octokit = stubOctokit(() => {
      throw githubError(404);
    });

    await expect(
      getPullRequest(INSTALLATION_ID, "acme-corp", "secret", 1, { octokit, logger }),
    ).resolves.toEqual({ ok: false, reason: "NOT_ACCESSIBLE" });
  });

  it("returns UNAVAILABLE with a warn for a 200 body missing head.sha", async () => {
    const octokit = stubOctokit(() => ({
      data: { id: 1, number: 1, base: { sha: "abc" } }, // head.sha missing
    }));

    await expect(
      getPullRequest(INSTALLATION_ID, "acme-corp", "service-1", 1, { octokit, logger }),
    ).resolves.toEqual({ ok: false, reason: "UNAVAILABLE" });
    expect(logger.warn).toHaveBeenCalledWith(
      "github returned a pull request body this code does not understand",
      expect.objectContaining({ installationId: "58234971" }),
    );
  });
});

// ---------------------------------------------------------------------------
// listOpenPullRequests
// ---------------------------------------------------------------------------

describe("listOpenPullRequests", () => {
  it("maps GitHub's list shape, including a draft PR with a deleted (null) author", async () => {
    const octokit = stubOctokit(() => ({
      data: loadFixtureBody("pull-requests-open-list"),
    }));

    const result = await listOpenPullRequests(INSTALLATION_ID, "acme-corp", "service-1", {
      octokit,
      logger,
    });

    expect(result.ok && result.pullRequests).toHaveLength(2);
    expect(result.ok && result.pullRequests[1]).toEqual({
      githubPrId: 1935423310n,
      number: 43,
      title: "Draft: prototype the diff-position map",
      authorLogin: null,
      authorAvatarUrl: null,
      state: "open",
      isDraft: true,
      baseRef: "main",
      baseSha: "6dcb09b5b57875f334f61aebed695e2e4193db5",
      headRef: "acme-corp/position-map-draft",
      headSha: "9f8e7d6c5b4a392817263544352617283940abcd",
      htmlUrl: "https://github.com/acme-corp/service-1/pull/43",
      githubCreatedAt: new Date("2026-08-22T08:30:00Z"),
      githubUpdatedAt: new Date("2026-08-22T08:30:00Z"),
    });
  });
});

// ---------------------------------------------------------------------------
// listPullRequestFiles
// ---------------------------------------------------------------------------

describe("listPullRequestFiles — pagination", () => {
  it("fully fetches a 150-file PR across two pages, truncated === false, exactly two requests", async () => {
    const page1 = loadFixtureBody("pull-request-files-page-1");
    const page2 = loadFixtureBody("pull-request-files-page-2");
    const octokit = stubOctokit((_route, params) =>
      Number(params?.page) === 1 ? { data: page1 } : { data: page2 },
    );

    const result = await listPullRequestFiles(
      INSTALLATION_ID,
      "acme-corp",
      "service-1",
      42,
      { octokit, logger },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.files).toHaveLength(150);
    expect(result.ok && result.truncated).toBe(false);
    expect(octokit.request).toHaveBeenCalledTimes(2);
  });

  it("stops at MAX_FILES_FETCHED (3,000) when an endpoint always returns a full page, truncated === true, and does not loop forever", async () => {
    const octokit = stubOctokit((_route, params) => ({
      data: Array.from({ length: 100 }, (_, i) => ({
        filename: `generated/file-${String(params?.page)}-${String(i)}.ts`,
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "@@ -0,0 +1,1 @@\n+x",
        sha: "a".repeat(40),
      })),
    }));

    const result = await listPullRequestFiles(
      INSTALLATION_ID,
      "acme-corp",
      "service-1",
      42,
      { octokit, logger },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.files).toHaveLength(3000);
    expect(result.ok && result.truncated).toBe(true);
    expect(octokit.request).toHaveBeenCalledTimes(30);
  });
});

describe("listPullRequestFiles — status normalization and renames", () => {
  it("maps all seven known statuses through, and falls back an unrecognized status to modified with a warn", async () => {
    const rawStatuses = [
      "added",
      "removed",
      "modified",
      "renamed",
      "copied",
      "changed",
      "unchanged",
      "totally-unknown-status",
    ];
    const octokit = stubOctokit(() => ({
      data: rawStatuses.map((status, i) => ({
        filename: `file-${String(i)}.ts`,
        status,
        additions: 1,
        deletions: 1,
        changes: 2,
        sha: "a".repeat(40),
      })),
    }));

    const result = await listPullRequestFiles(
      INSTALLATION_ID,
      "acme-corp",
      "service-1",
      42,
      { octokit, logger },
    );

    expect(result.ok && result.files.map((f) => f.status)).toEqual([
      "added",
      "removed",
      "modified",
      "renamed",
      "copied",
      "changed",
      "unchanged",
      "modified",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      "github returned an unrecognized file status; defaulting to modified",
      expect.objectContaining({ status: "totally-unknown-status" }),
    );
  });

  it("populates previousPath on a rename from previous_filename, and null on every other status", async () => {
    const page2 = loadFixtureBody("pull-request-files-page-2") as GithubPullRequestFile[];
    const octokit = stubOctokit(() => ({ data: page2 }));

    const result = await listPullRequestFiles(
      INSTALLATION_ID,
      "acme-corp",
      "service-1",
      42,
      { octokit, logger },
    );
    const files = result.ok ? result.files : [];

    const renamed = files.find((f) => f.status === "renamed");
    expect(renamed?.previousPath).toBe("src/old-name.ts");
    expect(renamed?.path).toBe("src/new-name.ts");

    for (const file of files.filter((f) => f.status !== "renamed")) {
      expect(file.previousPath).toBeNull();
    }
  });

  it("keeps a file entry with patch absent as null, never undefined", async () => {
    const octokit = stubOctokit(() => ({
      data: loadFixtureBody("pull-request-files-missing-patch"),
    }));

    const result = await listPullRequestFiles(
      INSTALLATION_ID,
      "acme-corp",
      "service-1",
      42,
      { octokit, logger },
    );

    expect(result.ok && result.files).toHaveLength(2);
    expect(result.ok && result.files.every((f) => f.patch === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getPullRequestDiff — the media-type response
// ---------------------------------------------------------------------------

describe("getPullRequestDiff", () => {
  it("returns the raw diff text when the response body arrives as a string", async () => {
    const diff = loadDiffFixture();
    const octokit = stubOctokit(() => ({ data: diff }));

    const result = await getPullRequestDiff(
      INSTALLATION_ID,
      "acme-corp",
      "service-1",
      42,
      { octokit, logger },
    );

    expect(result).toEqual({ ok: true, diff });
  });

  it("decodes an ArrayBuffer body — the other real shape the installed fetch-wrapper can hand back", async () => {
    const diff = "diff --git a/x b/x\n@@ -1,1 +1,1 @@\n-a\n+b";
    const buffer = new TextEncoder().encode(diff).buffer;
    const octokit = stubOctokit(() => ({ data: buffer }));

    const result = await getPullRequestDiff(
      INSTALLATION_ID,
      "acme-corp",
      "service-1",
      42,
      { octokit, logger },
    );

    expect(result).toEqual({ ok: true, diff });
  });
});

// ---------------------------------------------------------------------------
// splitDiffByFile — pure function, dedicated cases
// ---------------------------------------------------------------------------

describe("splitDiffByFile", () => {
  it("splits a multi-file diff into one entry per file", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "index 111..222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@",
      "-old a",
      "+new a",
      "diff --git a/b.ts b/b.ts",
      "index 333..444 100644",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1,1 +1,1 @@",
      "-old b",
      "+new b",
    ].join("\n");

    const result = splitDiffByFile(diff);

    expect([...result.keys()]).toEqual(["a.ts", "b.ts"]);
    expect(result.get("a.ts")).toBe("@@ -1,1 +1,1 @@\n-old a\n+new a");
    expect(result.get("b.ts")).toBe("@@ -1,1 +1,1 @@\n-old b\n+new b");
  });

  it("keys a removed file on its old (a/) path, since '+++' is /dev/null", () => {
    const diff = [
      "diff --git a/gone.sh b/gone.sh",
      "deleted file mode 100644",
      "index abc..000 100644",
      "--- a/gone.sh",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-echo bye",
    ].join("\n");

    const result = splitDiffByFile(diff);

    expect(result.get("gone.sh")).toBe("@@ -1,1 +0,0 @@\n-echo bye");
  });

  it("maps a pure rename with no hunks to an empty string, key still present", () => {
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
    ].join("\n");

    const result = splitDiffByFile(diff);

    expect(result.has("new.ts")).toBe(true);
    expect(result.get("new.ts")).toBe("");
  });

  it("maps a binary file (no hunks) to an empty string", () => {
    const diff = [
      "diff --git a/image.png b/image.png",
      "index abc..def 100644",
      "Binary files a/image.png and b/image.png differ",
    ].join("\n");

    const result = splitDiffByFile(diff);

    expect(result.get("image.png")).toBe("");
  });

  it("handles a path containing a space", () => {
    const diff = [
      "diff --git a/my file.txt b/my file.txt",
      "index 111..222 100644",
      "--- a/my file.txt",
      "+++ b/my file.txt",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");

    const result = splitDiffByFile(diff);

    expect(result.get("my file.txt")).toBe("@@ -1,1 +1,1 @@\n-old\n+new");
  });

  it("treats a patch body line that itself starts with 'diff --git' as content, not a new file boundary", () => {
    const diff = [
      "diff --git a/docs/git-output.md b/docs/git-output.md",
      "index 111..222 100644",
      "--- a/docs/git-output.md",
      "+++ b/docs/git-output.md",
      "@@ -1,1 +1,2 @@",
      " # Example",
      "+running `diff --git a/x b/x` shows this",
    ].join("\n");

    const result = splitDiffByFile(diff);

    expect([...result.keys()]).toEqual(["docs/git-output.md"]);
    expect(result.get("docs/git-output.md")).toBe(
      "@@ -1,1 +1,2 @@\n # Example\n+running `diff --git a/x b/x` shows this",
    );
  });

  it("splits the full fixture diff into every expected key", () => {
    const result = splitDiffByFile(loadDiffFixture());

    expect(result.get("assets/logo.png")).toBe("");
    expect(result.get("src/new-name.ts")).toBe("");
    expect(result.get("scripts/deploy.sh")).toContain("-echo deploying");
    expect(result.get("docs/release notes.md")).toContain("+- pagination guard");
    expect(result.get("src/huge-generated.ts")).toContain("ROW_COUNT = 12000");
  });
});

// ---------------------------------------------------------------------------
// fetchPatchesForMissing — the cost regression check (spec §14)
// ---------------------------------------------------------------------------

describe("fetchPatchesForMissing", () => {
  it("makes zero GitHub calls when no file is missing a patch", async () => {
    const octokit = stubOctokit(() => ({ data: "unused" }));
    const files: GithubPullRequestFile[] = [
      {
        path: "a.ts",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "@@ -1,1 +1,1 @@\n-a\n+b",
        sha: "a".repeat(40),
      },
    ];

    const result = await fetchPatchesForMissing(
      INSTALLATION_ID,
      "acme-corp",
      "service-1",
      42,
      files,
      { octokit, logger },
    );

    expect(result).toEqual({ files, fallbackUsed: false, fallbackFailed: false });
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it("makes exactly one call and fills both missing patches", async () => {
    // Go through listPullRequestFiles first so `patch` is genuinely `null` (GitHub's raw
    // body just omits the key) rather than hand-faking an already-typed input.
    const filesOctokit = stubOctokit(() => ({
      data: loadFixtureBody("pull-request-files-missing-patch"),
    }));
    const listResult = await listPullRequestFiles(
      INSTALLATION_ID,
      "acme-corp",
      "service-1",
      42,
      { octokit: filesOctokit, logger },
    );
    const files = listResult.ok ? listResult.files : [];
    expect(files.every((f) => f.patch === null)).toBe(true);

    const diff = loadDiffFixture();
    const diffOctokit = stubOctokit(() => ({ data: diff }));

    const result = await fetchPatchesForMissing(
      INSTALLATION_ID,
      "acme-corp",
      "service-1",
      42,
      files,
      { octokit: diffOctokit, logger },
    );

    expect(diffOctokit.request).toHaveBeenCalledTimes(1);
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackFailed).toBe(false);
    expect(result.files.find((f) => f.path === "assets/logo.png")?.patch).toBe("");
    expect(
      result.files.find((f) => f.path === "src/huge-generated.ts")?.patch,
    ).toContain("ROW_COUNT = 12000");
  });

  it("returns the files unchanged with fallbackFailed: true when the diff call itself fails, and does not throw", async () => {
    const octokit = stubOctokit(() => {
      throw githubError(500);
    });
    const files: GithubPullRequestFile[] = [
      {
        path: "a.ts",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: null,
        sha: null,
      },
    ];

    const result = await fetchPatchesForMissing(
      INSTALLATION_ID,
      "acme-corp",
      "service-1",
      42,
      files,
      { octokit, logger },
    );

    expect(result).toEqual({ files, fallbackUsed: true, fallbackFailed: true });
  });
});
