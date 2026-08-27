import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRepoContext,
  findPackageForFile,
  findTsconfigForFile,
  getPackageNameForFile,
} from "./repo-context.js";

const tempDirs: string[] = [];

async function makeTempRepo(
  files: Record<string, string>,
): Promise<{ dir: string; paths: string[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-context-test-"));
  tempDirs.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const abs = path.join(dir, relativePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return { dir, paths: Object.keys(files) };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("buildRepoContext", () => {
  it("handles a single-package repo with no workspace at all", async () => {
    const { dir, paths } = await makeTempRepo({
      "package.json": JSON.stringify({
        name: "my-app",
        dependencies: { lodash: "^4.17.21" },
      }),
      "src/index.ts": "export const x = 1;\n",
    });

    const context = await buildRepoContext(dir, paths);

    expect(context.packages).toHaveLength(1);
    expect(context.packages[0]).toMatchObject({ dir: "", name: "my-app" });
    expect(context.workspaceRoots).toEqual([]);
    expect(context.malformedManifestCount).toBe(0);
  });

  it("detects a pnpm workspace and expands its glob patterns against real package directories", async () => {
    const { dir, paths } = await makeTempRepo({
      "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n  - "packages/*"\n',
      "package.json": JSON.stringify({ name: "root", private: true }),
      "apps/web/package.json": JSON.stringify({ name: "@repo/web" }),
      "packages/ui/package.json": JSON.stringify({ name: "@repo/ui" }),
    });

    const context = await buildRepoContext(dir, paths);

    expect(context.workspaceMarkers.pnpmWorkspaceYaml).toBe(true);
    expect(new Set(context.workspaceRoots)).toEqual(
      new Set(["apps/web", "packages/ui"]),
    );
  });

  it("detects an npm workspaces array in the root package.json", async () => {
    const { dir, paths } = await makeTempRepo({
      "package.json": JSON.stringify({
        name: "root",
        workspaces: ["packages/*"],
      }),
      "packages/core/package.json": JSON.stringify({ name: "@repo/core" }),
    });

    const context = await buildRepoContext(dir, paths);

    expect(context.workspaceMarkers.npmWorkspacesField).toBe(true);
    expect(context.workspaceRoots).toEqual(["packages/core"]);
  });

  it("follows a tsconfig extends chain, with the leaf's own paths/baseUrl winning", async () => {
    const { dir, paths } = await makeTempRepo({
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@shared/*": ["packages/shared/src/*"] },
        },
      }),
      "apps/web/tsconfig.json": JSON.stringify({
        extends: "../../tsconfig.base.json",
        compilerOptions: { paths: { "@/*": ["src/*"] } },
      }),
      "apps/web/src/index.ts": "export {};\n",
    });

    const context = await buildRepoContext(dir, paths);

    const tsconfig = findTsconfigForFile(context, "apps/web/src/index.ts");
    expect(tsconfig).not.toBeNull();
    // The leaf's own `paths` replaces the parent's wholesale (real tsc behavior) —
    // "@shared/*" from the base is gone, "@/*" from the leaf is present.
    expect(tsconfig?.paths).toEqual({ "@/*": ["src/*"] });
    // baseUrl was not redeclared by the leaf, so the inherited one from the base survives,
    // resolved relative to the BASE config's own directory.
    expect(tsconfig?.baseUrl).toBe("");
  });

  it("guards against a tsconfig extends cycle rather than hanging", async () => {
    const { dir, paths } = await makeTempRepo({
      "tsconfig.a.json": JSON.stringify({
        extends: "./tsconfig.b.json",
        compilerOptions: { paths: { "@a/*": ["a/*"] } },
      }),
      "tsconfig.b.json": JSON.stringify({
        extends: "./tsconfig.a.json",
        compilerOptions: { paths: { "@b/*": ["b/*"] } },
      }),
      "tsconfig.json": JSON.stringify({ extends: "./tsconfig.a.json" }),
      "src/index.ts": "export {};\n",
    });

    const start = Date.now();
    const context = await buildRepoContext(dir, paths);
    expect(Date.now() - start).toBeLessThan(2000);

    const tsconfig = findTsconfigForFile(context, "src/index.ts");
    expect(tsconfig).not.toBeNull();
  });

  it("tolerates JSONC comments and trailing commas in tsconfig.json", async () => {
    const { dir, paths } = await makeTempRepo({
      "tsconfig.json": [
        "{",
        "  // a comment",
        '  "compilerOptions": {',
        '    "baseUrl": ".", // trailing comment',
        '    "paths": {',
        '      "@/*": ["src/*"],',
        "    },",
        "  },",
        "}",
      ].join("\n"),
      "src/index.ts": "export {};\n",
    });

    const context = await buildRepoContext(dir, paths);
    const tsconfig = findTsconfigForFile(context, "src/index.ts");
    expect(tsconfig?.paths).toEqual({ "@/*": ["src/*"] });
  });

  it("degrades gracefully — not a hard failure — on a genuinely malformed tsconfig", async () => {
    const { dir, paths } = await makeTempRepo({
      "tsconfig.json": "{ this is not json at all !!! ",
      "src/index.ts": "export {};\n",
    });

    const context = await buildRepoContext(dir, paths);
    expect(context.malformedManifestCount).toBeGreaterThan(0);
    expect(findTsconfigForFile(context, "src/index.ts")).toBeNull();
  });

  it("treats a missing root tsconfig.json as normal, not an error", async () => {
    const { dir, paths } = await makeTempRepo({
      "src/index.ts": "export {};\n",
    });
    const context = await buildRepoContext(dir, paths);
    expect(context.malformedManifestCount).toBe(0);
    expect(findTsconfigForFile(context, "src/index.ts")).toBeNull();
  });

  it("excludes a vendored package.json that escaped hard-ignore filtering (§22's own guard)", async () => {
    // Simulates a caller that (incorrectly) included a node_modules-nested package.json in
    // indexedFilePaths — buildRepoContext must still cross-check against isHardIgnored
    // itself, rather than trusting the input list blindly.
    const { dir, paths } = await makeTempRepo({
      "package.json": JSON.stringify({ name: "root" }),
      "node_modules/left-pad/package.json": JSON.stringify({
        name: "left-pad",
      }),
    });

    const context = await buildRepoContext(dir, paths);
    expect(context.packages.map((p) => p.name)).toEqual(["root"]);
  });

  it("records go.work/nx.json/turbo.json presence without attempting resolution from them", async () => {
    const { dir, paths } = await makeTempRepo({
      "go.work": "go 1.22\n\nuse (\n\t./a\n)\n",
      "nx.json": "{}",
      "turbo.json": "{}",
      "package.json": JSON.stringify({ name: "root" }),
    });

    const context = await buildRepoContext(dir, paths);
    expect(context.workspaceMarkers.goWork).toBe(true);
    expect(context.workspaceMarkers.nxJson).toBe(true);
    expect(context.workspaceMarkers.turboJson).toBe(true);
  });
});

describe("getPackageNameForFile", () => {
  it("upgrades packageName from a directory path to the declared name", async () => {
    const { dir, paths } = await makeTempRepo({
      "packages/core/package.json": JSON.stringify({ name: "@repo/core" }),
      "packages/core/src/index.ts": "export {};\n",
    });
    const context = await buildRepoContext(dir, paths);
    expect(getPackageNameForFile(context, "packages/core/src/index.ts")).toBe(
      "@repo/core",
    );
  });

  it("falls back to the directory path when the package.json has no name field", async () => {
    const { dir, paths } = await makeTempRepo({
      "packages/core/package.json": JSON.stringify({ private: true }),
      "packages/core/src/index.ts": "export {};\n",
    });
    const context = await buildRepoContext(dir, paths);
    expect(getPackageNameForFile(context, "packages/core/src/index.ts")).toBe(
      "packages/core",
    );
  });

  it("returns null when no ancestor package.json exists at all", async () => {
    const { dir, paths } = await makeTempRepo({
      "src/index.ts": "export {};\n",
    });
    const context = await buildRepoContext(dir, paths);
    expect(getPackageNameForFile(context, "src/index.ts")).toBeNull();
    expect(findPackageForFile(context, "src/index.ts")).toBeNull();
  });
});
