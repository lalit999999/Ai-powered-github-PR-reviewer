import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { walkTree } from "./walk-tree.js";

function noopLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const tempDirs: string[] = [];

async function makeTempRepo(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "walk-tree-test-"));
  tempDirs.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const abs = path.join(dir, relativePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("walkTree", () => {
  it("indexes an ordinary source file with the correct hash and metadata", async () => {
    const content = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
    const dir = await makeTempRepo({ "src/math.ts": content });

    const summary = await walkTree(dir, { logger: noopLogger() as never });

    expect(summary.files).toHaveLength(1);
    expect(summary.files[0]).toMatchObject({
      path: "src/math.ts",
      contentHash: sha256(content),
      sizeBytes: Buffer.byteLength(content),
      indexState: "INDEXED",
      skipReason: null,
      classification: "SOURCE",
      language: "typescript",
    });
    expect(summary.hardIgnoredCount).toBe(0);
    expect(summary.failedCount).toBe(0);
  });

  it("gives a hard-ignored path no row at all, and prunes the whole subtree", async () => {
    const dir = await makeTempRepo({
      "src/index.ts": "export const x = 1;\n",
      "node_modules/pkg/index.js": "module.exports = {};\n",
      "node_modules/pkg/package.json": '{"name":"pkg"}\n',
    });

    const summary = await walkTree(dir, { logger: noopLogger() as never });

    expect(summary.files.map((f) => f.path)).toEqual(["src/index.ts"]);
    expect(summary.hardIgnoredCount).toBe(2);
    // The pruned node_modules/pkg/package.json must never pollute package-root
    // detection — proven indirectly: src/index.ts's packageName is null, not "node_modules/pkg".
    expect(summary.files[0]?.packageName).toBeNull();
  });

  it("gives a .gitattributes-generated file a row marked SKIPPED_GENERATED, not a silent drop", async () => {
    const dir = await makeTempRepo({
      ".gitattributes": "api/**/*.pb.go linguist-generated\n",
      "api/v1/service.pb.go": "package v1\n",
    });

    const summary = await walkTree(dir, { logger: noopLogger() as never });

    // Two files: .gitattributes itself (an ordinary, legitimately-indexed repo file)
    // and the generated one it declares.
    expect(summary.files).toHaveLength(2);
    const generated = summary.files.find((f) => f.path === "api/v1/service.pb.go");
    expect(generated).toMatchObject({
      indexState: "SKIPPED",
      skipReason: "SKIPPED_GENERATED",
      isGenerated: true,
    });
    expect(summary.skippedByReason).toEqual({ SKIPPED_GENERATED: 1 });
  });

  it("gives an over-cap file a row marked SKIPPED_TOO_LARGE with a real streamed hash", async () => {
    const big = Buffer.alloc(600 * 1024, "a");
    const dir = await makeTempRepo({ "assets/big.txt": big });

    const summary = await walkTree(dir, { logger: noopLogger() as never });

    expect(summary.files[0]).toMatchObject({
      indexState: "SKIPPED",
      skipReason: "SKIPPED_TOO_LARGE",
      sizeBytes: big.byteLength,
      contentHash: sha256(big),
      lineCount: 0,
    });
  });

  it("gives a binary file a row marked SKIPPED_BINARY", async () => {
    const binary = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("rest")]);
    const dir = await makeTempRepo({ "assets/blob.dat": binary });

    const summary = await walkTree(dir, { logger: noopLogger() as never });

    expect(summary.files[0]).toMatchObject({ indexState: "SKIPPED", skipReason: "SKIPPED_BINARY" });
  });

  it("gives a minified file a row marked SKIPPED_MINIFIED", async () => {
    // "dist/" would be hard-ignored — pick a path that only trips the minified
    // heuristic, not the hard-ignore stage.
    const line = "a".repeat(600);
    const dir = await makeTempRepo({ "src/vendor-inline.js": `${line}\n${line}\n` });

    const summary = await walkTree(dir, { logger: noopLogger() as never });

    expect(summary.files[0]).toMatchObject({ indexState: "SKIPPED", skipReason: "SKIPPED_MINIFIED" });
  });

  it("marks an unreadable path FAILED and continues the walk rather than throwing", async () => {
    const dir = await makeTempRepo({
      "src/good.ts": "export const ok = true;\n",
      "src/broken.ts": "content that will become unreadable",
    });
    // Force a real read failure (EACCES) rather than simulating one — chmod 0 makes
    // fs.readFile actually fail, unlike replacing the path with a directory (which
    // would just make the walker see an empty subdirectory instead of a file at all).
    await fs.chmod(path.join(dir, "src/broken.ts"), 0o000);

    const summary = await walkTree(dir, { logger: noopLogger() as never });

    const broken = summary.files.find((f) => f.path === "src/broken.ts");
    const good = summary.files.find((f) => f.path === "src/good.ts");
    expect(broken).toMatchObject({ indexState: "FAILED", skipReason: null });
    expect(good).toMatchObject({ indexState: "INDEXED" });
    expect(summary.failedCount).toBe(1);

    // Restore permissions so afterEach's recursive rm can actually delete it.
    await fs.chmod(path.join(dir, "src/broken.ts"), 0o644);
  });

  it("resolves the nearest package root across a small monorepo layout", async () => {
    const dir = await makeTempRepo({
      "package.json": '{"name":"root"}\n',
      "apps/api/package.json": '{"name":"api"}\n',
      "apps/api/src/index.ts": "export {};\n",
      "apps/web/package.json": '{"name":"web"}\n',
      "apps/web/src/index.ts": "export {};\n",
      "README.md": "# repo\n",
    });

    const summary = await walkTree(dir, { logger: noopLogger() as never });
    const byPath = Object.fromEntries(summary.files.map((f) => [f.path, f]));

    expect(byPath["apps/api/src/index.ts"]?.packageName).toBe("apps/api");
    expect(byPath["apps/web/src/index.ts"]?.packageName).toBe("apps/web");
    expect(byPath["README.md"]?.packageName).toBe(".");
  });

  it("logs a repository health note when hard-ignore removes most of the tree", async () => {
    const files: Record<string, string> = { "src/index.ts": "export {};\n" };
    for (let i = 0; i < 200; i += 1) {
      files[`node_modules/pkg${i.toString()}/index.js`] = "module.exports = {};\n";
    }
    const dir = await makeTempRepo(files);
    const logger = noopLogger();

    const summary = await walkTree(dir, { logger: logger as never });

    expect(summary.hardIgnoredCount).toBe(200);
    expect(summary.hardIgnoreRatio).toBeGreaterThan(0.5);
    expect(logger.warn).toHaveBeenCalledWith(
      "repository health note: hard-ignore rules removed most of this repository's files",
      expect.objectContaining({ hardIgnoredCount: 200 }),
    );
  });

  it("an empty repository produces an empty summary with no division-by-zero", async () => {
    const dir = await makeTempRepo({});
    const summary = await walkTree(dir, { logger: noopLogger() as never });
    expect(summary.files).toEqual([]);
    expect(summary.hardIgnoreRatio).toBe(0);
  });
});
