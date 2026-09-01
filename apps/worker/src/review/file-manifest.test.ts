import { describe, expect, it } from "vitest";
import { buildManifest, type ManifestFileInput } from "./file-manifest.js";

const SIMPLE_PATCH = "@@ -0,0 +1,1 @@\n+x";

function sourceFile(i: number, overrides: Partial<ManifestFileInput> = {}): ManifestFileInput {
  const idx = String(i).padStart(3, "0");
  return {
    path: `src/file${idx}.ts`,
    previousPath: null,
    status: "added",
    additions: 1,
    deletions: 0,
    patch: SIMPLE_PATCH,
    inboundEdgeCount: 0,
    exportsPublicApi: false,
    noTestLinked: false,
    ...overrides,
  };
}

describe("buildManifest — 350 SOURCE files, both caps fire", () => {
  // Descending inboundEdgeCount gives every file a distinct priority score, so sorted
  // rank == input index, and the cap boundaries land exactly where asserted below.
  const files = Array.from({ length: 350 }, (_, i) => sourceFile(i, { inboundEdgeCount: 350 - i }));
  const manifest = buildManifest(files, { githubTruncated: false });

  it("keeps all 350 rows — the excess are listed, never dropped", () => {
    expect(manifest.files).toHaveLength(350);
  });

  it("exactly the first 40 ranked files are DEEP", () => {
    const first40 = manifest.files.slice(0, 40);
    expect(first40.every((f) => f.reviewDepth === "DEEP")).toBe(true);
    expect(manifest.deepFileCount).toBe(40);
  });

  it("ranks 41-300 (260 files) are SHALLOW — demoted from DEEP, not SKIP", () => {
    const middle = manifest.files.slice(40, 300);
    expect(middle).toHaveLength(260);
    expect(middle.every((f) => f.reviewDepth === "SHALLOW")).toBe(true);
    expect(manifest.shallowFileCount).toBe(260);
  });

  it("ranks 301-350 (50 files) are SKIP — past MAX_FILES_CONSIDERED", () => {
    const tail = manifest.files.slice(300, 350);
    expect(tail).toHaveLength(50);
    expect(tail.every((f) => f.reviewDepth === "SKIP")).toBe(true);
    expect(manifest.skippedFileCount).toBe(50);
  });

  it("truncated is true", () => {
    expect(manifest.truncated).toBe(true);
  });
});

describe("buildManifest — 10 files, no caps", () => {
  it("no caps fire, truncated is false, and the counts add up to 10", () => {
    const files = Array.from({ length: 10 }, (_, i) => sourceFile(i));
    const manifest = buildManifest(files, { githubTruncated: false });

    expect(manifest.truncated).toBe(false);
    expect(manifest.deepFileCount).toBe(10);
    expect(manifest.shallowFileCount).toBe(0);
    expect(manifest.skippedFileCount).toBe(0);
    expect(manifest.deepFileCount + manifest.shallowFileCount + manifest.skippedFileCount).toBe(10);
  });
});

describe("buildManifest — githubTruncated", () => {
  it("githubTruncated: true with only 5 files still sets truncated: true", () => {
    const files = Array.from({ length: 5 }, (_, i) => sourceFile(i));
    const manifest = buildManifest(files, { githubTruncated: true });

    expect(manifest.truncated).toBe(true);
  });
});

describe("buildManifest — determinism", () => {
  it("two files with an identical priority score come out in path order", () => {
    const fileB = sourceFile(0, { path: "b.ts" });
    const fileA = sourceFile(0, { path: "a.ts" });

    const manifest = buildManifest([fileB, fileA], { githubTruncated: false });

    expect(manifest.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("running buildManifest twice on a shuffled input array produces byte-identical output", () => {
    const files = Array.from({ length: 20 }, (_, i) => sourceFile(i, { inboundEdgeCount: i }));
    const shuffled = [...files].reverse();

    const manifestA = buildManifest(files, { githubTruncated: false });
    const manifestB = buildManifest(shuffled, { githubTruncated: false });

    expect(manifestB).toEqual(manifestA);
  });
});

describe("buildManifest — a mixed PR", () => {
  it("each file gets its documented depth, and the three counts sum to the file count", () => {
    const REMOVED_PATCH = `@@ -1,3 +0,0 @@\n${["a", "b", "c"].map((l) => `-${l}`).join("\n")}`;
    const CHANGE_PATCH = "@@ -1,1 +1,1 @@\n-a\n+b";

    const files: ManifestFileInput[] = [
      // SOURCE, added, has a patch -> DEEP.
      {
        path: "src/math.ts",
        previousPath: null,
        status: "added",
        additions: 10,
        deletions: 0,
        patch: SIMPLE_PATCH,
        inboundEdgeCount: 0,
        exportsPublicApi: false,
        noTestLinked: false,
      },
      // TEST -> SHALLOW.
      {
        path: "src/math.test.ts",
        previousPath: null,
        status: "added",
        additions: 10,
        deletions: 0,
        patch: SIMPLE_PATCH,
        inboundEdgeCount: 0,
        exportsPublicApi: false,
        noTestLinked: false,
      },
      // DEPENDENCY_LOCK -> SKIP.
      {
        path: "pnpm-lock.yaml",
        previousPath: null,
        status: "modified",
        additions: 5,
        deletions: 5,
        patch: CHANGE_PATCH,
        inboundEdgeCount: 0,
        exportsPublicApi: false,
        noTestLinked: false,
      },
      // DOCUMENTATION -> SHALLOW.
      {
        path: "README.md",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: CHANGE_PATCH,
        inboundEdgeCount: 0,
        exportsPublicApi: false,
        noTestLinked: false,
      },
      // ASSET, and GitHub omitted the patch (binary) -> SKIP via !hasPatch.
      {
        path: "logo.png",
        previousPath: null,
        status: "added",
        additions: 0,
        deletions: 0,
        patch: null,
        inboundEdgeCount: 0,
        exportsPublicApi: false,
        noTestLinked: false,
      },
      // status: removed -> SKIP, regardless of classification or patch size.
      {
        path: "src/old.ts",
        previousPath: null,
        status: "removed",
        additions: 0,
        deletions: 3,
        patch: REMOVED_PATCH,
        inboundEdgeCount: 0,
        exportsPublicApi: false,
        noTestLinked: false,
      },
      // status: renamed, no content change -> SKIP.
      {
        path: "src/renamed-only.ts",
        previousPath: "src/old-name.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        patch: null,
        inboundEdgeCount: 0,
        exportsPublicApi: false,
        noTestLinked: false,
      },
    ];

    const manifest = buildManifest(files, { githubTruncated: false });
    const byPath = new Map(manifest.files.map((f) => [f.path, f]));

    expect(byPath.get("src/math.ts")?.reviewDepth).toBe("DEEP");
    expect(byPath.get("src/math.test.ts")?.reviewDepth).toBe("SHALLOW");
    expect(byPath.get("pnpm-lock.yaml")?.reviewDepth).toBe("SKIP");
    expect(byPath.get("README.md")?.reviewDepth).toBe("SHALLOW");
    expect(byPath.get("logo.png")?.reviewDepth).toBe("SKIP");
    expect(byPath.get("src/old.ts")?.reviewDepth).toBe("SKIP");
    expect(byPath.get("src/renamed-only.ts")?.reviewDepth).toBe("SKIP");

    expect(manifest.deepFileCount + manifest.shallowFileCount + manifest.skippedFileCount).toBe(files.length);
  });
});

describe("buildManifest — a file whose patch is null", () => {
  it("gets diffPositionMap.empty === true and reviewDepth SKIP, and does not throw", () => {
    const files: ManifestFileInput[] = [
      {
        path: "assets/photo.bin",
        previousPath: null,
        status: "added",
        additions: 0,
        deletions: 0,
        patch: null,
        inboundEdgeCount: 0,
        exportsPublicApi: false,
        noTestLinked: false,
      },
    ];

    expect(() => buildManifest(files, { githubTruncated: false })).not.toThrow();

    const manifest = buildManifest(files, { githubTruncated: false });
    expect(manifest.files[0]?.diffPositionMap.empty).toBe(true);
    expect(manifest.files[0]?.reviewDepth).toBe("SKIP");
  });
});
