import { describe, expect, it } from "vitest";
import {
  BINARY_SNIFF_BYTES,
  classify,
  classifyFile,
  countLines,
  detectBinary,
  detectIsGenerated,
  detectIsTest,
  detectLanguage,
  detectMinified,
  detectPackageName,
  isOverSizeCap,
  MINIFIED_AVERAGE_LINE_LENGTH,
  SIZE_CAP_BYTES,
} from "./file-classifier.js";

describe("isOverSizeCap", () => {
  it("a file exactly at the cap is not over it", () => {
    expect(isOverSizeCap(SIZE_CAP_BYTES)).toBe(false);
  });

  it("a file one byte over the cap is over it", () => {
    expect(isOverSizeCap(SIZE_CAP_BYTES + 1)).toBe(true);
  });

  it("a small file is not over the cap", () => {
    expect(isOverSizeCap(100)).toBe(false);
  });
});

describe("detectBinary", () => {
  it("a NUL byte at the very start of the sniff window is detected", () => {
    const buf = Buffer.concat([Buffer.from([0]), Buffer.from("rest is text")]);
    expect(detectBinary(buf)).toBe(true);
  });

  it("a NUL byte at the last byte of an 8KB sniff window is detected", () => {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES, "a");
    buf[BINARY_SNIFF_BYTES - 1] = 0;
    expect(detectBinary(buf)).toBe(true);
  });

  it("a NUL byte just past the 8KB boundary is not detected, because the caller never sniffs past it", () => {
    // This module never reads past what it is given — the caller (classify(), or
    // indexer.service.ts directly) is responsible for bounding the sniff to exactly
    // BINARY_SNIFF_BYTES. A NUL at offset 8192 in the real file simply never appears in
    // an 8191-byte-max sniff window.
    const fullFile = Buffer.alloc(BINARY_SNIFF_BYTES + 1, "a");
    fullFile[BINARY_SNIFF_BYTES] = 0; // offset 8192 (0-indexed), one past the window
    const sniffWindow = fullFile.subarray(0, BINARY_SNIFF_BYTES);
    expect(detectBinary(sniffWindow)).toBe(false);
  });

  it("ordinary text has no NUL byte", () => {
    expect(detectBinary(Buffer.from("export function foo() {}\n"))).toBe(false);
  });
});

describe("detectMinified", () => {
  it("a genuinely minified bundle (long average line length) is detected", () => {
    const line = "a".repeat(MINIFIED_AVERAGE_LINE_LENGTH + 100);
    const content = Buffer.from(`${line}\n${line}\n${line}\n`);
    expect(detectMinified(content)).toBe(true);
  });

  it("one very long line among many short ones is NOT flagged — it's the average, not the max", () => {
    const shortLines = Array.from({ length: 50 }, (_, i) => `const x${i.toString()} = ${i.toString()};`);
    const oneLongLine = "a".repeat(5000);
    const content = Buffer.from([...shortLines, oneLongLine].join("\n"));
    expect(detectMinified(content)).toBe(false);
  });

  it("ordinary source with short lines is not minified", () => {
    const content = Buffer.from("function add(a, b) {\n  return a + b;\n}\n");
    expect(detectMinified(content)).toBe(false);
  });

  it("an empty file is never minified", () => {
    expect(detectMinified(Buffer.alloc(0))).toBe(false);
  });

  it("a trailing newline's empty segment does not drag the average down", () => {
    const line = "a".repeat(MINIFIED_AVERAGE_LINE_LENGTH + 50);
    // Without excluding the trailing empty segment, this would average (600+0)/2 = 300,
    // under the threshold, and wrongly miss a single-line minified file.
    const content = Buffer.from(`${line}\n`);
    expect(detectMinified(content)).toBe(true);
  });
});

describe("countLines", () => {
  it("counts lines matching detectMinified's own line-splitting convention", () => {
    expect(countLines(Buffer.from("a\nb\nc\n"))).toBe(3);
    expect(countLines(Buffer.from("a\nb\nc"))).toBe(3);
    expect(countLines(Buffer.alloc(0))).toBe(0);
  });
});

describe("detectLanguage", () => {
  it.each([
    ["src/index.ts", "typescript"],
    ["src/App.tsx", "typescript"],
    ["src/index.js", "javascript"],
    ["main.py", "python"],
    ["main.go", "go"],
    ["lib.rs", "rust"],
    ["README.md", "markdown"],
    ["config.yaml", "yaml"],
  ])("%s -> %s", (relativePath, expected) => {
    expect(detectLanguage(relativePath)).toBe(expected);
  });

  it("an unrecognized extension is null, never guessed", () => {
    expect(detectLanguage("data.xyz123")).toBeNull();
    expect(detectLanguage("Makefile")).toBeNull();
  });
});

describe("detectIsTest", () => {
  it.each([
    "src/__tests__/foo.ts",
    "test/foo.ts",
    "tests/foo.ts",
    "spec/foo.rb",
    "src/foo.test.ts",
    "src/foo.spec.ts",
    "src/foo_test.py",
    "src/foo-test.js",
  ])("flags %s as a test file", (relativePath) => {
    expect(detectIsTest(relativePath)).toBe(true);
  });

  it.each(["src/index.ts", "src/contest.ts", "src/latest.ts"])("does not flag %s", (relativePath) => {
    expect(detectIsTest(relativePath)).toBe(false);
  });
});

describe("detectIsGenerated", () => {
  it.each(["api/service.pb.go", "src/schema.generated.ts", "src/generated/foo.ts", "generated/foo.ts", ".generated/bar.ts"])(
    "flags %s as generated",
    (relativePath) => {
      expect(detectIsGenerated(relativePath)).toBe(true);
    },
  );

  it.each(["src/index.ts", "src/generation-utils.ts", "src/gen/foo.ts"])("does not flag %s", (relativePath) => {
    // "gen" alone is deliberately too loose a match to accept (it would false-positive
    // on a directory like "src/general/") — only the full "generated" segment counts.
    expect(detectIsGenerated(relativePath)).toBe(false);
  });
});

describe("detectPackageName", () => {
  it("resolves the nearest ancestor package root, longest match first", () => {
    const roots = ["apps/api", "apps/web", "."];
    expect(detectPackageName("apps/api/src/index.ts", roots)).toBe("apps/api");
    expect(detectPackageName("apps/web/src/index.tsx", roots)).toBe("apps/web");
  });

  it("falls back to the repository-root package when no nested root matches", () => {
    const roots = ["apps/api", "."];
    expect(detectPackageName("README.md", roots)).toBe(".");
  });

  it("returns null when there is no root at all", () => {
    expect(detectPackageName("README.md", [])).toBeNull();
  });

  it("does not match a sibling directory whose name extends the root's", () => {
    const roots = ["apps/api", "."];
    // apps/api-legacy is NOT under apps/api, even though it shares a string prefix.
    expect(detectPackageName("apps/api-legacy/src/index.ts", roots)).toBe(".");
  });
});

describe("classifyFile", () => {
  it("a lockfile is DEPENDENCY_LOCK regardless of other signals", () => {
    expect(classifyFile("package-lock.json", false, false, "json")).toBe("DEPENDENCY_LOCK");
  });

  it("a test file is TEST even if it would otherwise look like SOURCE", () => {
    expect(classifyFile("src/foo.test.ts", true, false, "typescript")).toBe("TEST");
  });

  it("a generated file is GENERATED", () => {
    expect(classifyFile("src/schema.generated.ts", false, true, "typescript")).toBe("GENERATED");
  });

  it("a README is DOCUMENTATION", () => {
    expect(classifyFile("README.md", false, false, "markdown")).toBe("DOCUMENTATION");
  });

  it("a png is ASSET", () => {
    expect(classifyFile("logo.png", false, false, null)).toBe("ASSET");
  });

  it("an eslintrc is CONFIG even though its extension looks like plain JSON", () => {
    expect(classifyFile(".eslintrc.json", false, false, "json")).toBe("CONFIG");
  });

  it("package.json is CONFIG", () => {
    expect(classifyFile("package.json", false, false, "json")).toBe("CONFIG");
  });

  it("a recognized-language file with no other signal is SOURCE", () => {
    expect(classifyFile("src/index.ts", false, false, "typescript")).toBe("SOURCE");
  });

  it("an unrecognized file with no other signal is UNKNOWN", () => {
    expect(classifyFile("Makefile", false, false, null)).toBe("UNKNOWN");
  });
});

describe("classify — the combined decision, in order", () => {
  it("size cap is checked before any content read", () => {
    const decision = classify("big.ts", SIZE_CAP_BYTES + 1, Buffer.from("anything"), []);
    expect(decision).toEqual({ skip: true, reason: "SKIPPED_TOO_LARGE" });
  });

  it("binary detection runs for files at/under the cap", () => {
    const content = Buffer.concat([Buffer.from([0]), Buffer.from("rest")]);
    const decision = classify("blob.dat", content.byteLength, content, []);
    expect(decision).toEqual({ skip: true, reason: "SKIPPED_BINARY" });
  });

  it("minified detection runs after binary detection passes", () => {
    const line = "a".repeat(MINIFIED_AVERAGE_LINE_LENGTH + 10);
    const content = Buffer.from(`${line}\n${line}\n`);
    const decision = classify("bundle.js", content.byteLength, content, []);
    expect(decision).toEqual({ skip: true, reason: "SKIPPED_MINIFIED" });
  });

  it("a clean source file produces a full classification result", () => {
    const content = Buffer.from("export function add(a: number, b: number) {\n  return a + b;\n}\n");
    const decision = classify("src/math.ts", content.byteLength, content, ["."]);
    expect(decision).toEqual({
      skip: false,
      classification: "SOURCE",
      language: "typescript",
      isTest: false,
      isGenerated: false,
      packageName: ".",
    });
  });
});
