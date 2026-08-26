import { builtinModules } from "node:module";
import path from "node:path";
import {
  findPackageForFile,
  findTsconfigForFile,
  type PackageManifest,
  type RepoContext,
  type TsconfigEntry,
} from "./repo-context.js";

/**
 * Prompt 3, sub-task 3.2: `plan.md` §11.2's five-step import-resolution ladder, in
 * exactly the stated order, short-circuiting at the first applicable step. Pure — no
 * filesystem I/O (`repo-context.ts` already gathered everything this module needs into
 * {@link RepoContext}), which is what makes this unit-testable against hand-built
 * fixture data with no temp directory involved.
 *
 * ## Discriminated result, never a bare `string | null`
 *
 * Prompt 4 needs to distinguish `RESOLVED` (a real file edge) from `EXTERNAL` (a package
 * dependency, no file edge) from `UNRESOLVED` (recorded with the raw specifier, a health
 * signal) — {@link ImportResolution} carries that distinction explicitly rather than
 * requiring the caller to re-derive it from a string's shape.
 */

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type ImportResolution =
  | { status: "RESOLVED"; targetFilePath: string }
  | { status: "EXTERNAL"; packageName: string; version?: string }
  | { status: "UNRESOLVED"; specifier: string };

// ---------------------------------------------------------------------------
// Bounds — specifiers are attacker-controllable repository content (§0 rule 4)
// ---------------------------------------------------------------------------

/** Longer than any real import specifier a human would write; caps the pathological case
 * (`plan.md` §13/§0 rule 4's own DoS concern) before any string work happens on it. */
export const MAX_SPECIFIER_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Extension ladder — order is load-bearing (§0's own emphasis)
// ---------------------------------------------------------------------------

/** `.ts` before `.js`: in a TypeScript repository, `./foo` almost always means `foo.ts`. */
const RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

/** ESM/NodeNext interop (this very repository's own convention): a `.js`/`.jsx`/`.mjs`/
 * `.cjs` specifier resolves to its `.ts`/`.tsx`/`.mts`/`.cts` sibling first, when one
 * exists, before ever considering the literal `.js` file — mandatory per spec §14/§0's
 * own worked example, not an edge case. */
const JS_TO_TS_SWAP: Readonly<Record<string, string>> = {
  ".js": ".ts",
  ".jsx": ".tsx",
  ".mjs": ".mts",
  ".cjs": ".cts",
};

function posixExtname(p: string): string {
  const base = path.posix.basename(p);
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx);
}

/**
 * Resolves `basePath` (an already-repo-root-relative candidate, extension or not) against
 * {@link RepoContext.files} using the ladder from `plan.md` §11.2 step 1: JS→TS swap,
 * then the literal path as given, then (only if `basePath` has no extension at all) each
 * extension appended in order, then — last, per §0's explicit ordering requirement —
 * directory `/index.*` forms. Returns the resolved repository-relative path, or `null`.
 */
function resolveViaExtensionLadder(basePath: string, files: ReadonlySet<string>): string | null {
  const ext = posixExtname(basePath);

  const swap = JS_TO_TS_SWAP[ext];
  if (swap) {
    const swapped = `${basePath.slice(0, basePath.length - ext.length)}${swap}`;
    if (files.has(swapped)) return swapped;
  }

  if (files.has(basePath)) return basePath;

  if (ext === "") {
    for (const candidateExt of RESOLUTION_EXTENSIONS) {
      const candidate = `${basePath}${candidateExt}`;
      if (files.has(candidate)) return candidate;
    }
  }

  for (const candidateExt of RESOLUTION_EXTENSIONS) {
    const candidate = `${basePath}/index${candidateExt}`;
    if (files.has(candidate)) return candidate;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Repo-relative path arithmetic — never leave the repository root
// ---------------------------------------------------------------------------

/**
 * Resolves `specifier` (a `.`/`..`-relative path, or an already-relative target derived
 * from a `paths` alias substitution) against `fromDir`, entirely with plain segment
 * arithmetic — the same class of defence `archive-extractor.ts`'s `resolveSafePath`
 * implements (§0 rule 4's own pointer), adapted to repository-relative POSIX strings
 * rather than real filesystem paths (there is no filesystem here to escape from, only a
 * `Set<string>` of known-good paths, but a specifier like
 * `../../../../../../etc/passwd` must still resolve to nothing, not to a garbage string
 * that happens not to be in the set — see this module's own path-escape test).
 * A plain loop over `split("/")`, not a regex — linear in the number of path segments,
 * with no backtracking to reason about at all.
 */
function resolveRepoRelativePath(fromDir: string, specifier: string): string | null {
  const combined = fromDir === "" ? specifier : `${fromDir}/${specifier}`;
  const segments = combined.split("/");
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null; // would escape the repository root
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join("/");
}

function dirOf(filePath: string): string {
  const dir = path.posix.dirname(filePath);
  return dir === "." ? "" : dir;
}

// ---------------------------------------------------------------------------
// Step 1 — relative specifiers
// ---------------------------------------------------------------------------

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..";
}

function resolveRelative(specifier: string, fromFilePath: string, files: ReadonlySet<string>): ImportResolution {
  const target = resolveRepoRelativePath(dirOf(fromFilePath), specifier);
  if (target === null) return { status: "UNRESOLVED", specifier };
  const resolved = resolveViaExtensionLadder(target, files);
  return resolved ? { status: "RESOLVED", targetFilePath: resolved } : { status: "UNRESOLVED", specifier };
}

// ---------------------------------------------------------------------------
// Step 2 — tsconfig `paths` alias (longest-prefix) and `baseUrl`
// ---------------------------------------------------------------------------

/**
 * Longest-prefix matching over `paths` keys, per `plan.md` §11.2 step 2's own example
 * (`{"@/*": [...], "@/lib/*": [...]}` must prefer `@/lib/*` for `@/lib/utils`). An exact
 * (non-wildcard) key always outranks any wildcard key, matching real `tsc` precedence.
 * Wildcard keys use the general `prefix*suffix` shape TS's own grammar allows (a bare
 * `prefix*` — no suffix — is the overwhelmingly common case, handled identically as
 * `suffix === ""`).
 */
function matchPathsAlias(specifier: string, paths: Record<string, string[]>): { targets: string[]; wildcard: string } | null {
  if (paths[specifier]) return { targets: paths[specifier], wildcard: "" };

  let best: { targets: string[]; wildcard: string; prefixLength: number } | null = null;
  for (const [key, targets] of Object.entries(paths)) {
    const starIndex = key.indexOf("*");
    if (starIndex === -1) continue;
    const prefix = key.slice(0, starIndex);
    const suffix = key.slice(starIndex + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (specifier.length < prefix.length + suffix.length) continue;
    const wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
    if (best === null || prefix.length > best.prefixLength) {
      best = { targets, wildcard, prefixLength: prefix.length };
    }
  }
  return best ? { targets: best.targets, wildcard: best.wildcard } : null;
}

function substituteWildcard(target: string, wildcard: string): string {
  return target.includes("*") ? target.replace("*", wildcard) : target;
}

/**
 * `paths` aliases (longest-prefix match, wildcard substitution) then, only if no `paths`
 * key matched at all, a plain `baseUrl`-relative attempt — a real, common `tsc` feature
 * (`baseUrl: "src"` lets `import "components/Foo"` resolve relative to `src` with no
 * `paths` entry at all). Returns `null` when neither applies (the specifier is not
 * alias-shaped at all under this tsconfig), letting the caller continue the ladder;
 * returns a terminal `ImportResolution` once a `paths`/`baseUrl` match was *attempted*,
 * per `plan.md`'s own "apply mapping, then step 1" framing — a matched alias whose target
 * cannot be found on disk is `UNRESOLVED`, not silently retried as a workspace package.
 */
function resolveViaPathsOrBaseUrl(specifier: string, tsconfig: TsconfigEntry, files: ReadonlySet<string>): ImportResolution | null {
  if (tsconfig.paths) {
    const match = matchPathsAlias(specifier, tsconfig.paths);
    if (match) {
      const baseDir = tsconfig.baseUrl ?? tsconfig.dir;
      for (const rawTarget of match.targets) {
        const substituted = substituteWildcard(rawTarget, match.wildcard);
        const joined = resolveRepoRelativePath(baseDir, substituted);
        if (joined === null) continue;
        const resolved = resolveViaExtensionLadder(joined, files);
        if (resolved) return { status: "RESOLVED", targetFilePath: resolved };
      }
      return { status: "UNRESOLVED", specifier };
    }
  }

  if (tsconfig.baseUrl !== undefined) {
    const joined = resolveRepoRelativePath(tsconfig.baseUrl, specifier);
    if (joined !== null) {
      const resolved = resolveViaExtensionLadder(joined, files);
      if (resolved) return { status: "RESOLVED", targetFilePath: resolved };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Step 3 — workspace package name
// ---------------------------------------------------------------------------

function splitBareSpecifier(specifier: string): { packageName: string; subpath: string } | null {
  if (specifier.startsWith("@")) {
    const secondSlash = specifier.indexOf("/", specifier.indexOf("/") + 1);
    const firstSlash = specifier.indexOf("/");
    if (firstSlash === -1) return null; // "@scope" alone is not a valid package specifier
    const packageName = secondSlash === -1 ? specifier : specifier.slice(0, secondSlash);
    const subpath = secondSlash === -1 ? "" : specifier.slice(secondSlash + 1);
    return { packageName, subpath };
  }
  const firstSlash = specifier.indexOf("/");
  const packageName = firstSlash === -1 ? specifier : specifier.slice(0, firstSlash);
  const subpath = firstSlash === -1 ? "" : specifier.slice(firstSlash + 1);
  return { packageName, subpath };
}

/**
 * Resolves the common `exports` shapes only — a bare string (`"./dist/index.js"`), a
 * conditions object at the top level (`{"import": "...", "default": "..."}`), a
 * subpath map (`{".": ..., "./foo": ...}`, values themselves a string or conditions
 * object), and a single trailing-`*` wildcard subpath pattern
 * (`{"./*": "./dist/*.js"}`). Anything more exotic (nested condition+subpath
 * combinations, multiple wildcards, condition arrays) is **not** guessed at — `null` is
 * returned and the caller buckets the whole import `UNRESOLVED` rather than risk a wrong
 * file edge (§0 rule 3: ambiguity is worse than absence).
 */
function resolveExportsEntry(exportsField: unknown, subpath: string): string | null {
  const key = subpath === "" ? "." : `./${subpath}`;

  function unwrapConditions(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      for (const condition of ["import", "default", "types"]) {
        const inner = obj[condition];
        if (typeof inner === "string") return inner;
      }
    }
    return null;
  }

  if (typeof exportsField === "string") {
    return subpath === "" ? exportsField : null;
  }

  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) return null;
  const map = exportsField as Record<string, unknown>;

  if (key in map) {
    const resolved = unwrapConditions(map[key]);
    return resolved;
  }

  // A top-level conditions object with no subpath keys at all (no leading "./" keys).
  const hasSubpathKeys = Object.keys(map).some((k) => k.startsWith("."));
  if (!hasSubpathKeys) {
    return subpath === "" ? unwrapConditions(map) : null;
  }

  if (subpath !== "") {
    for (const [mapKey, value] of Object.entries(map)) {
      const starIndex = mapKey.indexOf("*");
      if (starIndex === -1 || !mapKey.startsWith("./")) continue;
      const prefix = mapKey.slice(2, starIndex);
      const suffix = mapKey.slice(starIndex + 1);
      if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
        const wildcard = subpath.slice(prefix.length, subpath.length - suffix.length);
        const resolved = unwrapConditions(value);
        if (resolved) return substituteWildcard(resolved, wildcard);
      }
    }
  }

  return null;
}

function resolvePackageEntryPoint(pkg: PackageManifest, subpath: string, files: ReadonlySet<string>): string | null {
  if (pkg.exports !== undefined) {
    const fromExports = resolveExportsEntry(pkg.exports, subpath);
    if (fromExports) {
      const joined = resolveRepoRelativePath(pkg.dir, fromExports);
      const resolved = joined === null ? null : resolveViaExtensionLadder(joined, files);
      if (resolved) return resolved;
    }
    // `exports` present but this subpath is not covered by it (or resolved to a
    // nonexistent file) — an `exports` map is usually intentionally restrictive, so no
    // further fallback is attempted for THIS specific subpath. The bare-package (no
    // subpath) case below still tries `main`/`module`/`types` regardless, since a real
    // package commonly declares both for backward compatibility.
    if (subpath !== "") return null;
  }

  if (subpath === "") {
    for (const field of [pkg.types, pkg.module, pkg.main]) {
      if (!field) continue;
      const joined = resolveRepoRelativePath(pkg.dir, field);
      const resolved = joined === null ? null : resolveViaExtensionLadder(joined, files);
      if (resolved) return resolved;
    }
    const indexResolved = resolveViaExtensionLadder(pkg.dir, files);
    if (indexResolved) return indexResolved;
    return null;
  }

  // No `exports` map at all — fall back to a direct relative-path attempt from the
  // package root, the common case for workspace packages with no `exports` field.
  const joined = resolveRepoRelativePath(pkg.dir, subpath);
  return joined === null ? null : resolveViaExtensionLadder(joined, files);
}

function resolveWorkspacePackage(specifier: string, context: RepoContext): ImportResolution | null {
  const split = splitBareSpecifier(specifier);
  if (!split) return null;

  const workspaceRootSet = new Set(context.workspaceRoots);
  const pkg = context.packages.find((p) => p.name === split.packageName && workspaceRootSet.has(p.dir));
  if (!pkg) return null;

  const resolved = resolvePackageEntryPoint(pkg, split.subpath, context.files);
  return resolved ? { status: "RESOLVED", targetFilePath: resolved } : { status: "UNRESOLVED", specifier };
}

// ---------------------------------------------------------------------------
// Step 4 — bare specifier: node builtins and external packages
// ---------------------------------------------------------------------------

/** `node:` prefix is unambiguous on its own. Bare (unprefixed) builtins — `"fs"`,
 * `"path"`, … — are matched against Node's own {@link builtinModules} list rather than a
 * hand-maintained copy, so this stays correct across Node versions with zero maintenance. */
const BARE_BUILTIN_NAMES = new Set(builtinModules);

function matchNodeBuiltin(specifier: string): string | null {
  if (specifier.startsWith("node:")) return specifier;
  const split = splitBareSpecifier(specifier);
  if (split && BARE_BUILTIN_NAMES.has(split.packageName)) return split.packageName;
  return null;
}

function lookupDependencyVersion(packageName: string, fromFilePath: string, context: RepoContext): string | undefined {
  const owner = findPackageForFile(context, fromFilePath);
  const candidates = owner ? [owner, ...context.packages.filter((p) => p.dir === "")] : context.packages.filter((p) => p.dir === "");
  for (const pkg of candidates) {
    const version = pkg.dependencies[packageName] ?? pkg.devDependencies[packageName] ?? pkg.peerDependencies[packageName];
    if (version) return version;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// `package.json#imports` subpath imports (`#internal/...`)
// ---------------------------------------------------------------------------

/** Only the direct, non-wildcard case (`"#internal/x": "./src/internal/x.ts"`) is
 * handled — cheap and unambiguous. A wildcard `imports` pattern is bucketed `UNRESOLVED`
 * rather than guessed at, per §0's own instruction for this exact feature. */
function resolveSubpathImport(specifier: string, fromFilePath: string, context: RepoContext): ImportResolution | null {
  const owner = findPackageForFile(context, fromFilePath);
  const importsField = owner?.imports;
  if (!importsField || typeof importsField !== "object" || Array.isArray(importsField)) return null;
  const map = importsField as Record<string, unknown>;
  const value = map[specifier];
  if (value === undefined) return null;

  const target =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && !Array.isArray(value)
        ? (["import", "default"].map((c) => (value as Record<string, unknown>)[c]).find((v) => typeof v === "string") as
            | string
            | undefined)
        : undefined;
  if (!target) return { status: "UNRESOLVED", specifier };

  const joined = resolveRepoRelativePath(owner?.dir ?? "", target);
  const resolved = joined === null ? null : resolveViaExtensionLadder(joined, context.files);
  return resolved ? { status: "RESOLVED", targetFilePath: resolved } : { status: "UNRESOLVED", specifier };
}

// ---------------------------------------------------------------------------
// The public entry point
// ---------------------------------------------------------------------------

/**
 * `plan.md` §11.2's five-step ladder. `specifier` is bounded to
 * {@link MAX_SPECIFIER_LENGTH} before any work happens on it (§0 rule 4). An absolute
 * path (`/etc/passwd`, a Windows drive letter) is never a legitimate specifier in
 * repository source and resolves to `UNRESOLVED` immediately — it is not relative (step
 * 1 requires `./`/`../`), not alias-shaped, not a workspace/bare package name.
 */
export function resolveImport(specifier: string, fromFilePath: string, context: RepoContext): ImportResolution {
  if (specifier.length === 0) return { status: "UNRESOLVED", specifier };
  const bounded = specifier.length > MAX_SPECIFIER_LENGTH ? specifier.slice(0, MAX_SPECIFIER_LENGTH) : specifier;

  if (isRelativeSpecifier(bounded)) {
    return resolveRelative(bounded, fromFilePath, context.files);
  }

  // A fixed, non-repeating character class with no alternation-inside-repetition shape —
  // linear and non-backtracking regardless of input length; not worth hand-rolling as a
  // string scan for one two-character check (§0 rule 4).
  if (bounded.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(bounded)) {
    return { status: "UNRESOLVED", specifier: bounded };
  }

  const tsconfig = findTsconfigForFile(context, fromFilePath);
  if (tsconfig) {
    const aliasResult = resolveViaPathsOrBaseUrl(bounded, tsconfig, context.files);
    if (aliasResult) return aliasResult;
  }

  const builtin = matchNodeBuiltin(bounded);
  if (builtin) return { status: "EXTERNAL", packageName: builtin };

  const workspaceResult = resolveWorkspacePackage(bounded, context);
  if (workspaceResult) return workspaceResult;

  if (bounded.startsWith("#")) {
    const subpathResult = resolveSubpathImport(bounded, fromFilePath, context);
    return subpathResult ?? { status: "UNRESOLVED", specifier: bounded };
  }

  const split = splitBareSpecifier(bounded);
  if (split && split.packageName.length > 0) {
    return { status: "EXTERNAL", packageName: split.packageName, version: lookupDependencyVersion(split.packageName, fromFilePath, context) };
  }

  return { status: "UNRESOLVED", specifier: bounded };
}
