import { describe, expect, it } from "vitest";
import {
  classifyGitattributes,
  classifyIgnore,
  isHardIgnored,
  parseGitattributes,
} from "./ignore-rules.js";

describe("isHardIgnored", () => {
  it.each([
    "node_modules/lodash/index.js",
    ".git/HEAD",
    "vendor/github.com/foo/bar.go",
    "dist/main.js",
    "build/output.css",
    "out/index.html",
    ".next/static/chunk.js",
    "target/release/app",
    "__pycache__/mod.cpython-311.pyc",
    "coverage/lcov.info",
    ".venv/lib/python3.11/site.py",
    "src/app.min.js",
    "src/app.min.css",
    "dist/app.js.map",
    "src/app.bundle.js",
    "some.lock",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "go.sum",
    "Cargo.lock",
    "poetry.lock",
    "composer.lock",
    "src/__snapshots__/App.test.js.snap",
    "src/__snapshots__/nested/deep.snap",
    "logo.png",
    "photo.jpg",
    "photo.jpeg",
    "anim.gif",
    "icon.svg",
    "favicon.ico",
    "doc.pdf",
    "archive.zip",
    "font.woff",
    "font.woff2",
    "font.ttf",
    "clip.mp4",
    "module.wasm",
  ])("matches %s", (candidate) => {
    expect(isHardIgnored(candidate)).toBe(true);
  });

  it.each([
    "src/index.ts",
    "README.md",
    "package.json",
    // Looks like a lockfile but isn't one — "*.lock" only matches a literal ".lock"
    // extension, not any file whose name merely contains "lock".
    "src/lockManager.ts",
    // A directory that is merely *named* similarly to a hard-ignore target must not
    // match — "node_modules/**" requires the literal path segment.
    "src/my-node_modules-helper.ts",
    "src/vendored-code-comment.ts",
  ])("does not match %s", (candidate) => {
    expect(isHardIgnored(candidate)).toBe(false);
  });

  it("never reaches deeper checks for a hard-ignored path — the order is observable", () => {
    // A path under node_modules that would ALSO look like a legitimate 10-byte source
    // file if it reached file-classifier.ts — proven here only by confirming
    // isHardIgnored trips before any size/content check could run (this module has no
    // size/content check at all, which is the point: hard-ignore short-circuits the
    // whole pipeline before those checks exist for this path).
    expect(isHardIgnored("node_modules/tiny-pkg/index.js")).toBe(true);
  });
});

describe("parseGitattributes + classifyGitattributes", () => {
  it("flags a bare linguist-generated pattern", () => {
    const rules = parseGitattributes("*.pb.go linguist-generated\n");
    expect(classifyGitattributes("api/service.pb.go", rules)).toBe("GENERATED");
    expect(classifyGitattributes("api/service.go", rules)).toBeNull();
  });

  it("flags linguist-generated=true explicitly", () => {
    const rules = parseGitattributes("dist/** linguist-generated=true\n");
    expect(classifyGitattributes("dist/bundle.js", rules)).toBe("GENERATED");
  });

  it("flags linguist-vendored", () => {
    const rules = parseGitattributes("third_party/** linguist-vendored\n");
    expect(classifyGitattributes("third_party/lib.c", rules)).toBe("VENDORED");
  });

  it("ignores blank lines, comments, and unrelated attributes", () => {
    const rules = parseGitattributes(
      [
        "# a comment",
        "",
        "*.txt text eol=lf",
        "*.png binary",
        "generated/** linguist-generated",
      ].join("\n"),
    );
    expect(classifyGitattributes("README.txt", rules)).toBeNull();
    expect(classifyGitattributes("logo.png", rules)).toBeNull();
    expect(classifyGitattributes("generated/schema.ts", rules)).toBe(
      "GENERATED",
    );
  });

  it("a later line overrides an earlier one for the same path (last match wins)", () => {
    const rules = parseGitattributes(
      [
        "vendor/** linguist-vendored",
        "vendor/special/** -linguist-vendored",
      ].join("\n"),
    );
    expect(classifyGitattributes("vendor/lib/a.js", rules)).toBe("VENDORED");
    expect(classifyGitattributes("vendor/special/a.js", rules)).toBeNull();
  });

  it("-linguist-generated unsets an earlier bare match", () => {
    const rules = parseGitattributes(
      [
        "**/*.min.js linguist-generated",
        "src/hand-written.min.js -linguist-generated",
      ].join("\n"),
    );
    expect(classifyGitattributes("dist/x.min.js", rules)).toBe("GENERATED");
    expect(classifyGitattributes("src/hand-written.min.js", rules)).toBeNull();
  });

  it("generated wins when both flags are set on the same path", () => {
    const rules = parseGitattributes(
      "odd/** linguist-generated linguist-vendored\n",
    );
    expect(classifyGitattributes("odd/file.js", rules)).toBe("GENERATED");
  });

  it("an empty rule set never matches anything", () => {
    expect(classifyGitattributes("anything.ts", [])).toBeNull();
  });

  it("a slash-free pattern is unanchored — matches at any depth, gitignore-style", () => {
    const rules = parseGitattributes("*.pb.go linguist-generated\n");
    expect(classifyGitattributes("service.pb.go", rules)).toBe("GENERATED");
    expect(classifyGitattributes("api/v1/service.pb.go", rules)).toBe(
      "GENERATED",
    );
  });

  it("a pattern containing a slash is anchored to the repository root", () => {
    const rules = parseGitattributes("api/generated.go linguist-generated\n");
    expect(classifyGitattributes("api/generated.go", rules)).toBe("GENERATED");
    expect(classifyGitattributes("other/api/generated.go", rules)).toBeNull();
  });
});

describe("classifyIgnore — the combined, ordered decision", () => {
  it("hard-ignore wins even when a .gitattributes rule would also match", () => {
    const rules = parseGitattributes("node_modules/** linguist-vendored\n");
    expect(classifyIgnore("node_modules/pkg/index.js", rules)).toEqual({
      kind: "HARD_IGNORE",
    });
  });

  it("a .gitattributes-generated path that is not hard-ignored is SKIP, not HARD_IGNORE", () => {
    const rules = parseGitattributes("api/**/*.pb.go linguist-generated\n");
    expect(classifyIgnore("api/v1/service.pb.go", rules)).toEqual({
      kind: "SKIP",
      reason: "SKIPPED_GENERATED",
    });
  });

  it("a .gitattributes-vendored path is SKIP with SKIPPED_VENDORED", () => {
    const rules = parseGitattributes("third_party/** linguist-vendored\n");
    expect(classifyIgnore("third_party/lib.c", rules)).toEqual({
      kind: "SKIP",
      reason: "SKIPPED_VENDORED",
    });
  });

  it("an ordinary source file is KEEP", () => {
    expect(classifyIgnore("src/index.ts", [])).toEqual({ kind: "KEEP" });
  });
});
