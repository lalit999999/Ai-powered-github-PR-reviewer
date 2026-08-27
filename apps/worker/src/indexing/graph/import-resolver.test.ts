import { describe, expect, it } from "vitest";
import { resolveImport } from "./import-resolver.js";
import type {
  PackageManifest,
  RepoContext,
  TsconfigEntry,
} from "./repo-context.js";

function pkg(
  overrides: Partial<PackageManifest> & { dir: string },
): PackageManifest {
  return {
    dir: overrides.dir,
    path: `${overrides.dir}/package.json`,
    name: overrides.name ?? null,
    main: overrides.main,
    module: overrides.module,
    types: overrides.types,
    exports: overrides.exports,
    imports: overrides.imports,
    dependencies: overrides.dependencies ?? {},
    devDependencies: overrides.devDependencies ?? {},
    peerDependencies: overrides.peerDependencies ?? {},
  };
}

function tsconfig(
  overrides: Partial<TsconfigEntry> & { dir: string },
): TsconfigEntry {
  return {
    dir: overrides.dir,
    path: `${overrides.dir}/tsconfig.json`,
    baseUrl: overrides.baseUrl,
    paths: overrides.paths,
  };
}

interface ContextOverrides {
  files: readonly string[];
  tsconfigs?: readonly TsconfigEntry[];
  workspaceRoots?: readonly string[];
  packages?: readonly PackageManifest[];
  workspaceMarkers?: RepoContext["workspaceMarkers"];
  malformedManifestCount?: number;
  manifestScanTruncated?: boolean;
}

function context(overrides: ContextOverrides): RepoContext {
  return {
    tsconfigs: overrides.tsconfigs ?? [],
    workspaceRoots: overrides.workspaceRoots ?? [],
    packages: overrides.packages ?? [],
    files: new Set(overrides.files),
    workspaceMarkers: overrides.workspaceMarkers ?? {
      pnpmWorkspaceYaml: false,
      npmWorkspacesField: false,
      nxJson: false,
      turboJson: false,
      goWork: false,
    },
    malformedManifestCount: overrides.malformedManifestCount ?? 0,
    manifestScanTruncated: overrides.manifestScanTruncated ?? false,
  };
}

describe("resolveImport — step 1: relative specifiers", () => {
  it("resolves a .ts sibling for an extensionless specifier", () => {
    const ctx = context({ files: ["src/foo.ts", "src/bar.ts"] });
    expect(resolveImport("./foo", "src/bar.ts", ctx)).toEqual({
      status: "RESOLVED",
      targetFilePath: "src/foo.ts",
    });
  });

  it("prefers .ts over .js when both exist for an extensionless specifier", () => {
    const ctx = context({ files: ["src/foo.ts", "src/foo.js", "src/bar.ts"] });
    expect(resolveImport("./foo", "src/bar.ts", ctx)).toEqual({
      status: "RESOLVED",
      targetFilePath: "src/foo.ts",
    });
  });

  it("resolves a .js specifier to its .ts sibling — mandatory ESM/NodeNext interop", () => {
    const ctx = context({ files: ["src/foo.ts", "src/bar.ts"] });
    expect(resolveImport("./foo.js", "src/bar.ts", ctx)).toEqual({
      status: "RESOLVED",
      targetFilePath: "src/foo.ts",
    });
  });

  it("falls back to a literal .js file when no .ts sibling exists (plain JS repo)", () => {
    const ctx = context({ files: ["src/foo.js", "src/bar.js"] });
    expect(resolveImport("./foo.js", "src/bar.js", ctx)).toEqual({
      status: "RESOLVED",
      targetFilePath: "src/foo.js",
    });
  });

  it("resolves a directory import to its index file, only after direct extensions fail", () => {
    const ctx = context({ files: ["src/utils/index.ts", "src/bar.ts"] });
    expect(resolveImport("./utils", "src/bar.ts", ctx)).toEqual({
      status: "RESOLVED",
      targetFilePath: "src/utils/index.ts",
    });
  });

  it("prefers a direct file over a same-named directory's index file", () => {
    const ctx = context({
      files: ["src/utils.ts", "src/utils/index.ts", "src/bar.ts"],
    });
    expect(resolveImport("./utils", "src/bar.ts", ctx)).toEqual({
      status: "RESOLVED",
      targetFilePath: "src/utils.ts",
    });
  });

  it("resolves ../ parent-directory specifiers", () => {
    const ctx = context({ files: ["src/shared.ts", "src/nested/child.ts"] });
    expect(resolveImport("../shared", "src/nested/child.ts", ctx)).toEqual({
      status: "RESOLVED",
      targetFilePath: "src/shared.ts",
    });
  });

  it("is UNRESOLVED for a genuinely missing relative target", () => {
    const ctx = context({ files: ["src/bar.ts"] });
    expect(resolveImport("./nope", "src/bar.ts", ctx)).toEqual({
      status: "UNRESOLVED",
      specifier: "./nope",
    });
  });

  it("never leaves the repository root — a traversal escape resolves to nothing, not a garbage path", () => {
    const ctx = context({ files: ["etc/passwd.ts", "src/bar.ts"] });
    const result = resolveImport(
      "../../../../../../etc/passwd",
      "src/bar.ts",
      ctx,
    );
    expect(result).toEqual({
      status: "UNRESOLVED",
      specifier: "../../../../../../etc/passwd",
    });
  });

  it("treats an absolute-path specifier as unresolved, never as a real filesystem path", () => {
    const ctx = context({ files: ["etc/passwd.ts"] });
    expect(resolveImport("/etc/passwd", "src/bar.ts", ctx)).toEqual({
      status: "UNRESOLVED",
      specifier: "/etc/passwd",
    });
  });
});

describe("resolveImport — step 2: tsconfig paths alias", () => {
  it("applies a simple wildcard alias", () => {
    const ctx = context({
      files: ["src/components/Button.tsx", "src/app.tsx"],
      tsconfigs: [tsconfig({ dir: "", paths: { "@/*": ["src/*"] } })],
    });
    expect(resolveImport("@/components/Button", "src/app.tsx", ctx)).toEqual({
      status: "RESOLVED",
      targetFilePath: "src/components/Button.tsx",
    });
  });

  it("prefers the longest matching prefix among overlapping wildcard aliases", () => {
    const ctx = context({
      files: ["packages/shared/src/utils.ts", "src/lib/utils.ts", "src/app.ts"],
      tsconfigs: [
        tsconfig({
          dir: "",
          paths: { "@/*": ["src/*"], "@/lib/*": ["packages/shared/src/*"] },
        }),
      ],
    });
    expect(resolveImport("@/lib/utils", "src/app.ts", ctx)).toEqual({
      status: "RESOLVED",
      targetFilePath: "packages/shared/src/utils.ts",
    });
  });

  it("applies baseUrl-relative resolution when no paths key matches", () => {
    const ctx = context({
      files: ["src/components/Button.tsx", "src/app.tsx"],
      tsconfigs: [tsconfig({ dir: "", baseUrl: "src" })],
    });
    expect(resolveImport("components/Button", "src/app.tsx", ctx)).toEqual({
      status: "RESOLVED",
      targetFilePath: "src/components/Button.tsx",
    });
  });

  it("is UNRESOLVED (terminal) when a paths key matches but the target does not exist", () => {
    const ctx = context({
      files: ["src/app.tsx"],
      tsconfigs: [tsconfig({ dir: "", paths: { "@/*": ["src/*"] } })],
    });
    expect(resolveImport("@/does-not-exist", "src/app.tsx", ctx)).toEqual({
      status: "UNRESOLVED",
      specifier: "@/does-not-exist",
    });
  });

  it("prefers an exact (non-wildcard) paths key over any wildcard key", () => {
    const ctx = context({
      files: ["src/special-case.ts", "src/lib/config.ts", "src/app.ts"],
      tsconfigs: [
        tsconfig({
          dir: "",
          paths: { "@/config": ["src/special-case.ts"], "@/*": ["src/lib/*"] },
        }),
      ],
    });
    expect(resolveImport("@/config", "src/app.ts", ctx)).toEqual({
      status: "RESOLVED",
      targetFilePath: "src/special-case.ts",
    });
  });

  it("uses the nearest ancestor tsconfig for a file under a nested package", () => {
    const ctx = context({
      files: [
        "apps/web/src/app.tsx",
        "apps/web/src/lib/foo.ts",
        "packages/shared/src/foo.ts",
      ],
      tsconfigs: [
        tsconfig({
          dir: "",
          paths: { "@shared/*": ["packages/shared/src/*"] },
        }),
        tsconfig({ dir: "apps/web", paths: { "@/*": ["src/*"] } }),
      ],
    });
    expect(resolveImport("@/lib/foo", "apps/web/src/app.tsx", ctx)).toEqual({
      status: "RESOLVED",
      targetFilePath: "apps/web/src/lib/foo.ts",
    });
  });
});

describe("resolveImport — step 3: workspace package", () => {
  const workspaceContext = context({
    files: [
      "packages/ui/src/index.ts",
      "packages/ui/package.json",
      "apps/web/src/app.ts",
    ],
    packages: [
      pkg({ dir: "packages/ui", name: "@repo/ui", main: "src/index.ts" }),
      pkg({ dir: "apps/web", name: "web" }),
    ],
    workspaceRoots: ["packages/ui", "apps/web"],
  });

  it("resolves a bare workspace package name to its declared main entry point", () => {
    expect(
      resolveImport("@repo/ui", "apps/web/src/app.ts", workspaceContext),
    ).toEqual({
      status: "RESOLVED",
      targetFilePath: "packages/ui/src/index.ts",
    });
  });

  it("resolves a workspace package subpath relative to the package root when there is no exports map", () => {
    const ctx = context({
      files: ["packages/ui/src/Button.tsx", "apps/web/src/app.ts"],
      packages: [
        pkg({ dir: "packages/ui", name: "@repo/ui" }),
        pkg({ dir: "apps/web", name: "web" }),
      ],
      workspaceRoots: ["packages/ui", "apps/web"],
    });
    expect(
      resolveImport("@repo/ui/src/Button", "apps/web/src/app.ts", ctx),
    ).toEqual({
      status: "RESOLVED",
      targetFilePath: "packages/ui/src/Button.tsx",
    });
  });

  it("resolves via an exports map's exact subpath key", () => {
    const ctx = context({
      files: ["packages/ui/src/button.ts", "apps/web/src/app.ts"],
      packages: [
        pkg({
          dir: "packages/ui",
          name: "@repo/ui",
          exports: { ".": "./src/index.ts", "./button": "./src/button.ts" },
        }),
        pkg({ dir: "apps/web", name: "web" }),
      ],
      workspaceRoots: ["packages/ui", "apps/web"],
    });
    expect(
      resolveImport("@repo/ui/button", "apps/web/src/app.ts", ctx),
    ).toEqual({
      status: "RESOLVED",
      targetFilePath: "packages/ui/src/button.ts",
    });
  });

  it("resolves via an exports map's single-wildcard subpath pattern", () => {
    const ctx = context({
      files: ["packages/ui/dist/button.js", "apps/web/src/app.ts"],
      packages: [
        pkg({
          dir: "packages/ui",
          name: "@repo/ui",
          exports: { "./*": "./dist/*.js" },
        }),
        pkg({ dir: "apps/web", name: "web" }),
      ],
      workspaceRoots: ["packages/ui", "apps/web"],
    });
    expect(
      resolveImport("@repo/ui/button", "apps/web/src/app.ts", ctx),
    ).toEqual({
      status: "RESOLVED",
      targetFilePath: "packages/ui/dist/button.js",
    });
  });

  it("buckets an unresolvable workspace-package subpath as UNRESOLVED, not a guess", () => {
    expect(
      resolveImport(
        "@repo/ui/nonexistent",
        "apps/web/src/app.ts",
        workspaceContext,
      ),
    ).toEqual({
      status: "UNRESOLVED",
      specifier: "@repo/ui/nonexistent",
    });
  });
});

describe("resolveImport — step 4: bare specifiers (node builtins and external packages)", () => {
  it("treats a node: prefixed specifier as EXTERNAL", () => {
    const ctx = context({ files: ["src/app.ts"] });
    expect(resolveImport("node:fs", "src/app.ts", ctx)).toEqual({
      status: "EXTERNAL",
      packageName: "node:fs",
    });
  });

  it("treats a bare builtin module name as EXTERNAL", () => {
    const ctx = context({ files: ["src/app.ts"] });
    expect(resolveImport("path", "src/app.ts", ctx)).toEqual({
      status: "EXTERNAL",
      packageName: "path",
    });
  });

  it("treats an ordinary bare package specifier as EXTERNAL, with its version from package.json", () => {
    const ctx = context({
      files: ["src/app.ts", "package.json"],
      packages: [
        pkg({ dir: "", name: "root", dependencies: { lodash: "^4.17.21" } }),
      ],
    });
    expect(resolveImport("lodash", "src/app.ts", ctx)).toEqual({
      status: "EXTERNAL",
      packageName: "lodash",
      version: "^4.17.21",
    });
  });

  it("resolves a scoped bare package's name correctly (not the whole specifier)", () => {
    const ctx = context({ files: ["src/app.ts"] });
    expect(resolveImport("@sentry/node", "src/app.ts", ctx)).toEqual({
      status: "EXTERNAL",
      packageName: "@sentry/node",
    });
  });

  it("records EXTERNAL with no version when the package is not in any known manifest", () => {
    const ctx = context({ files: ["src/app.ts"] });
    expect(resolveImport("some-random-package", "src/app.ts", ctx)).toEqual({
      status: "EXTERNAL",
      packageName: "some-random-package",
    });
  });

  it("falls back to the root package.json's dependency version when the file's own package doesn't declare it", () => {
    const ctx = context({
      files: ["apps/web/src/app.ts", "package.json", "apps/web/package.json"],
      packages: [
        pkg({ dir: "", name: "root", dependencies: { lodash: "^4.17.21" } }),
        pkg({ dir: "apps/web", name: "web", dependencies: {} }),
      ],
    });
    expect(resolveImport("lodash", "apps/web/src/app.ts", ctx)).toEqual({
      status: "EXTERNAL",
      packageName: "lodash",
      version: "^4.17.21",
    });
  });
});

describe("resolveImport — package.json #imports subpath imports", () => {
  it("resolves a direct (non-wildcard) #subpath import", () => {
    const ctx = context({
      files: ["src/internal/logger.ts", "src/app.ts", "package.json"],
      packages: [
        pkg({
          dir: "",
          name: "root",
          imports: { "#logger": "./src/internal/logger.ts" },
        }),
      ],
    });
    expect(resolveImport("#logger", "src/app.ts", ctx)).toEqual({
      status: "RESOLVED",
      targetFilePath: "src/internal/logger.ts",
    });
  });

  it("buckets a wildcard #subpath import pattern as UNRESOLVED rather than guessing", () => {
    const ctx = context({
      files: ["src/internal/logger.ts", "src/app.ts", "package.json"],
      packages: [
        pkg({
          dir: "",
          name: "root",
          imports: { "#internal/*": "./src/internal/*.ts" },
        }),
      ],
    });
    expect(resolveImport("#internal/logger", "src/app.ts", ctx)).toEqual({
      status: "UNRESOLVED",
      specifier: "#internal/logger",
    });
  });

  it("is UNRESOLVED for a #subpath import with no matching imports field entry at all", () => {
    const ctx = context({
      files: ["src/app.ts", "package.json"],
      packages: [pkg({ dir: "", name: "root" })],
    });
    expect(resolveImport("#missing", "src/app.ts", ctx)).toEqual({
      status: "UNRESOLVED",
      specifier: "#missing",
    });
  });
});

describe("resolveImport — step 5: genuinely unresolvable specifiers", () => {
  it("is UNRESOLVED for an empty specifier", () => {
    const ctx = context({ files: ["src/app.ts"] });
    expect(resolveImport("", "src/app.ts", ctx)).toEqual({
      status: "UNRESOLVED",
      specifier: "",
    });
  });

  it("is UNRESOLVED for a malformed scoped specifier with no package segment", () => {
    const ctx = context({ files: ["src/app.ts"] });
    expect(resolveImport("@justscope", "src/app.ts", ctx)).toEqual({
      status: "UNRESOLVED",
      specifier: "@justscope",
    });
  });
});

describe("resolveImport — pathological input bounds", () => {
  it("completes quickly for an oversized (100 KB) specifier without throwing", () => {
    const ctx = context({ files: ["src/app.ts"] });
    const huge = `./${"a".repeat(100_000)}`;
    const start = Date.now();
    const result = resolveImport(huge, "src/app.ts", ctx);
    const elapsedMs = Date.now() - start;
    console.log(
      `resolveImport with a 100KB specifier completed in ${elapsedMs.toString()}ms`,
    );
    expect(elapsedMs).toBeLessThan(200);
    expect(result.status).toBe("UNRESOLVED");
  });

  it("completes quickly for a deeply nested ../ chain", () => {
    const ctx = context({ files: ["src/app.ts"] });
    const deep = `${"../".repeat(50_000)}etc/passwd`;
    const start = Date.now();
    const result = resolveImport(deep, "src/app.ts", ctx);
    const elapsedMs = Date.now() - start;
    console.log(
      `resolveImport with a 50,000-deep ../ chain completed in ${elapsedMs.toString()}ms`,
    );
    expect(elapsedMs).toBeLessThan(200);
    expect(result.status).toBe("UNRESOLVED");
  });
});
