import fs from "node:fs/promises";
import path from "node:path";
import micromatch from "micromatch";
import { isHardIgnored } from "../filter/ignore-rules.js";

/**
 * Prompt 3, sub-task 3.1: gathers repository-wide facts once (tsconfig/jsconfig `paths`
 * and `baseUrl`, workspace roots, the package map, external dependency versions, and the
 * set of indexed file paths) into one immutable {@link RepoContext} value. Both
 * `import-resolver.ts` and `call-resolver.ts` are pure functions over this value plus
 * per-file data — gathering the filesystem facts here, once, is what keeps those two
 * modules free of filesystem I/O entirely (§0 non-negotiable rule 2).
 *
 * `buildRepoContext` takes `indexedFilePaths` (the paths phase-03's `walkTree` already
 * discovered: every candidate path that survived hard-ignore, i.e. `WalkedFile.path`
 * across both `INDEXED` and `SKIPPED` rows) rather than re-walking the extracted tree a
 * second time — that list is already hard-ignore-filtered, so scanning it for manifest
 * basenames and cross-checking each hit against {@link isHardIgnored} again (§2's own
 * vendored-`package.json` guard) is strictly cheaper than a second recursive `readdir`
 * pass over a tree that can be hundreds of thousands of entries, and it cannot disagree
 * with what Phase 03 already decided to index.
 */

// ---------------------------------------------------------------------------
// Bounds — a repository is attacker-controllable content (§0 rule 4)
// ---------------------------------------------------------------------------

/** A `package.json`/`tsconfig.json` this small compared to `file-classifier.ts`'s own
 * 512 KB `SIZE_CAP_BYTES` for arbitrary source files is already generous for a manifest —
 * a bigger one is almost certainly not a hand-written config and is treated as malformed
 * rather than parsed. */
export const MAX_MANIFEST_BYTES = 256 * 1024;

/** A repository with more manifests than this is pathological (§0 rule 4's own example:
 * "5,000 `package.json` files"). Once the cap is hit, remaining manifests are recorded as
 * skipped-for-volume, not parsed — a bounded scan, not an unbounded one. */
export const MAX_MANIFESTS_SCANNED = 3000;

/** `extends` chains are attacker-controllable content too — a `tsconfig.json` that
 * `extends` itself (directly or through a longer cycle) must not hang this builder. */
const MAX_EXTENDS_CHAIN_DEPTH = 20;

// ---------------------------------------------------------------------------
// tsconfig / jsconfig
// ---------------------------------------------------------------------------

export interface TsconfigEntry {
  /** Directory containing this tsconfig, repository-relative, forward-slash. `paths`/
   * `baseUrl` apply to files under this directory (the nearest-ancestor rule
   * {@link findTsconfigForFile} implements). */
  dir: string;
  /** The manifest's own repository-relative path (`dir/tsconfig.json`). */
  path: string;
  /** Resolved (extends-chain-merged) `compilerOptions.baseUrl`, as a repository-relative
   * directory path — already joined against `dir`, never the raw manifest string. */
  baseUrl?: string;
  /** Resolved (extends-chain-merged) `compilerOptions.paths`. */
  paths?: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

export interface PackageManifest {
  /** Directory containing this `package.json`, repository-relative. */
  dir: string;
  path: string;
  /** The manifest's declared `"name"`, or `null` if absent/malformed — the fallback the
   * caller (`getPackageNameForFile`) uses is the directory path, matching phase-03's own
   * `detectPackageName` contract exactly (`docs/decisions/phase-03-log.md`). */
  name: string | null;
  main?: string;
  module?: string;
  types?: string;
  /** Raw `exports` field, kept as-is (string | object | null/undefined) — the shapes
   * `import-resolver.ts` needs to branch on are exactly the raw JSON shapes; normalizing
   * here would just move the branching without simplifying it. */
  exports?: unknown;
  /** Raw `imports` field (`#specifier` subpath imports) — same reasoning as `exports`. */
  imports?: unknown;
  dependencies: Readonly<Record<string, string>>;
  devDependencies: Readonly<Record<string, string>>;
  peerDependencies: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// The whole context
// ---------------------------------------------------------------------------

export interface WorkspaceMarkers {
  pnpmWorkspaceYaml: boolean;
  npmWorkspacesField: boolean;
  nxJson: boolean;
  turboJson: boolean;
  /** Recorded for completeness per spec §3 — this phase never builds Go resolution. */
  goWork: boolean;
}

export interface RepoContext {
  tsconfigs: readonly TsconfigEntry[];
  /** Package directories that are workspace members (i.e., matched by a `pnpm-workspace
   * .yaml` / `package.json#workspaces` glob) — sorted longest-first for nearest-ancestor
   * lookups, same convention as `walk-tree.ts`'s `derivePackageRoots`. Empty when the
   * repository is not a monorepo at all. */
  workspaceRoots: readonly string[];
  packages: readonly PackageManifest[];
  files: ReadonlySet<string>;
  workspaceMarkers: WorkspaceMarkers;
  /** Manifests that existed but failed to parse (over the size cap, invalid JSON even
   * after JSONC tolerance, or an `extends` cycle) — a soft-failure count, not a hard
   * failure (spec §12: "falls back to relative-only resolution... not a hard failure"). */
  malformedManifestCount: number;
  /** True once {@link MAX_MANIFESTS_SCANNED} was hit and some candidate manifests were
   * never read at all — distinct from `malformedManifestCount` (which counts manifests
   * that *were* read but failed to parse). */
  manifestScanTruncated: boolean;
}

// ---------------------------------------------------------------------------
// JSONC tolerance — tsconfig.json is JSONC by convention (comments, trailing commas)
// ---------------------------------------------------------------------------

const JSONC_WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

/**
 * One linear, single-pass scan over `text` that strips `//`/`/* *\/` comments and removes
 * trailing commas before `}`/`]` — both outside of string literals, tracked by a single
 * `inString` flag toggled on unescaped `"`. Deliberately plain string/character
 * comparisons, not a regex (§0 rule 4: "where a plain string operation will do, use it
 * instead of a regex") — there is no backtracking risk to reason about at all when the
 * scan is a single forward pass with O(1) work per character, which this is.
 */
function sanitizeJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  let inString = false;

  while (i < n) {
    const ch = text.charAt(i);

    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += text.charAt(i + 1);
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && text.charAt(i + 1) === "/") {
      while (i < n && text.charAt(i) !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && text.charAt(i + 1) === "*") {
      i += 2;
      while (i < n && !(text.charAt(i) === "*" && text.charAt(i + 1) === "/"))
        i += 1;
      i += 2;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < n && JSONC_WHITESPACE.has(text.charAt(j))) j += 1;
      const next = text.charAt(j);
      if (next === "}" || next === "]") {
        i += 1; // drop the trailing comma
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

/** Parses JSONC text, bounded by {@link MAX_MANIFEST_BYTES}. Returns `null` on any
 * failure (oversized, invalid JSON even after sanitizing, or not an object) — every
 * caller treats `null` as a soft failure, never a thrown exception. */
function parseJsoncObject(text: string): Record<string, unknown> | null {
  if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(sanitizeJsonc(text));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Repository-relative path helpers
// ---------------------------------------------------------------------------

function dirOf(relativePath: string): string {
  const dir = path.posix.dirname(relativePath);
  return dir === "." ? "" : dir;
}

function joinRel(dir: string, segment: string): string {
  return dir === "" ? segment : `${dir}/${segment}`;
}

// ---------------------------------------------------------------------------
// tsconfig extends-chain resolution
// ---------------------------------------------------------------------------

interface RawTsconfig {
  compilerOptions?: { baseUrl?: unknown; paths?: unknown };
  extends?: unknown;
}

/**
 * Resolves an `extends` value to a repository-relative manifest path. Only relative
 * specifiers (`./x`, `../x`) are handled — a bare-package `extends` (`@tsconfig/node18`)
 * would need `node_modules` resolution, which does not exist in this environment (§0's
 * "Phase 03 never runs `npm install`"); such a chain simply stops here, degrading to
 * whatever `baseUrl`/`paths` were gathered so far, not a hard failure.
 */
function resolveExtendsPath(
  extendsValue: string,
  fromDir: string,
): string | null {
  if (!extendsValue.startsWith("./") && !extendsValue.startsWith("../"))
    return null;
  const joined = path.posix.normalize(joinRel(fromDir, extendsValue));
  if (joined.startsWith("..")) return null; // never leave the repository root
  return joined.endsWith(".json") ? joined : `${joined}.json`;
}

interface MergedTsconfig {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

/**
 * Walks the `extends` chain starting at `entryPath`, merging `baseUrl`/`paths` with the
 * **most-derived** (closest to `entryPath`) declaration winning outright when present —
 * matching real `tsc` behavior, where a child's own `compilerOptions.paths` replaces the
 * parent's wholesale rather than merging key-by-key. A `visited` set guards the cycle a
 * tsconfig extending itself (directly or transitively) would otherwise cause; a cycle is
 * detected and the chain simply stops there, not a crash.
 */
interface MergeExtendsChainResult {
  merged: MergedTsconfig;
  /** `false` only when the *entry* manifest itself (not some further-up ancestor in its
   * `extends` chain) could not be read or parsed at all — the signal
   * {@link buildRepoContext} uses to count a malformed tsconfig. An entry that parses
   * fine but whose `extends` target is missing/malformed is a normal, documented degrade
   * (spec §12: "falls back to relative-only resolution... not a hard failure"), not
   * counted here. */
  entryReadable: boolean;
}

async function mergeExtendsChain(
  rootDir: string,
  entryPath: string,
  manifestBytes: Map<string, string | null>,
): Promise<MergeExtendsChainResult> {
  const chain: { dir: string; raw: RawTsconfig }[] = [];
  const visited = new Set<string>();
  let currentPath: string | null = entryPath;
  let depth = 0;

  while (currentPath !== null && depth < MAX_EXTENDS_CHAIN_DEPTH) {
    if (visited.has(currentPath)) break; // cycle guard
    visited.add(currentPath);
    depth += 1;

    let text = manifestBytes.get(currentPath);
    if (text === undefined) {
      text = await fs
        .readFile(path.join(rootDir, currentPath), "utf8")
        .then((t) =>
          Buffer.byteLength(t, "utf8") > MAX_MANIFEST_BYTES ? null : t,
        )
        .catch(() => null);
      manifestBytes.set(currentPath, text);
    }
    if (text === null) break;

    const parsed = parseJsoncObject(text);
    if (parsed === null) break;

    const raw: RawTsconfig = parsed;
    const dir = dirOf(currentPath);
    chain.push({ dir, raw });

    const extendsValue = raw.extends;
    currentPath =
      typeof extendsValue === "string"
        ? resolveExtendsPath(extendsValue, dir)
        : null;
  }

  // Apply furthest-ancestor first so a closer declaration overwrites it.
  const merged: MergedTsconfig = {};
  for (let idx = chain.length - 1; idx >= 0; idx -= 1) {
    const { dir, raw } = chain[idx]!;
    const co = raw.compilerOptions;
    if (co && typeof co.baseUrl === "string") {
      const normalized = path.posix.normalize(joinRel(dir, co.baseUrl));
      // `path.posix.normalize` maps the repo root to "." — every other path in this
      // module represents the repo root as "" (see `dirOf`); reconcile the one place
      // `normalize` is called on a value that can legitimately resolve to the root.
      merged.baseUrl = normalized === "." ? "" : normalized;
    }
    if (
      co &&
      co.paths &&
      typeof co.paths === "object" &&
      !Array.isArray(co.paths)
    ) {
      const pathsRecord: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(
        co.paths as Record<string, unknown>,
      )) {
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
          pathsRecord[key] = value;
        }
      }
      merged.paths = pathsRecord;
    }
  }
  return { merged, entryReadable: chain.length > 0 };
}

// ---------------------------------------------------------------------------
// package.json parsing
// ---------------------------------------------------------------------------

function readStringDeps(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function parsePackageManifest(
  dir: string,
  manifestPath: string,
  raw: Record<string, unknown>,
): PackageManifest {
  return {
    dir,
    path: manifestPath,
    name: typeof raw.name === "string" ? raw.name : null,
    main: typeof raw.main === "string" ? raw.main : undefined,
    module: typeof raw.module === "string" ? raw.module : undefined,
    types:
      typeof raw.types === "string"
        ? raw.types
        : typeof raw.typings === "string"
          ? (raw.typings as string)
          : undefined,
    exports: raw.exports,
    imports: raw.imports,
    dependencies: readStringDeps(raw.dependencies),
    devDependencies: readStringDeps(raw.devDependencies),
    peerDependencies: readStringDeps(raw.peerDependencies),
  };
}

// ---------------------------------------------------------------------------
// Workspace-glob matching — pnpm-workspace.yaml / package.json#workspaces
// ---------------------------------------------------------------------------

/**
 * `pnpm-workspace.yaml`'s `packages:` list is the one YAML shape this phase needs to
 * read. Rather than take a new dependency for a single, narrow, well-known shape, this is
 * a bounded, line-oriented scanner for exactly that shape (a top-level `packages:` key
 * followed by `- "glob"` / `- 'glob'` / `- glob` list items) — not a general YAML parser.
 * Any line that doesn't fit the pattern ends the list, matching real YAML block-sequence
 * semantics closely enough for this narrow purpose.
 */
function parsePnpmWorkspaceYaml(text: string): string[] {
  const lines = text.split("\n");
  const globs: string[] = [];
  let inPackagesList = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();

    if (!inPackagesList) {
      if (trimmed === "packages:") inPackagesList = true;
      continue;
    }

    if (trimmed.startsWith("- ")) {
      const item = trimmed.slice(2).trim();
      const unquoted =
        item.length >= 2 &&
        ((item.startsWith('"') && item.endsWith('"')) ||
          (item.startsWith("'") && item.endsWith("'")))
          ? item.slice(1, -1)
          : item;
      if (unquoted.length > 0) globs.push(unquoted);
      continue;
    }

    // A non-list-item, non-blank line at the same or lower indentation ends the block.
    if (trimmed.length > 0) break;
  }

  return globs;
}

function readNpmWorkspacesField(raw: Record<string, unknown>): string[] {
  const value = raw.workspaces;
  if (Array.isArray(value))
    return value.filter((v): v is string => typeof v === "string");
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { packages?: unknown }).packages)
  ) {
    return (value as { packages: unknown[] }).packages.filter(
      (v): v is string => typeof v === "string",
    );
  }
  return [];
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

const MANIFEST_BASENAMES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "nx.json",
  "turbo.json",
  "go.work",
]);

function isTsconfigLike(basename: string): boolean {
  return (
    basename === "tsconfig.json" ||
    basename === "jsconfig.json" ||
    (basename.startsWith("tsconfig.") && basename.endsWith(".json"))
  );
}

/**
 * Builds the immutable {@link RepoContext} from the extraction root plus the file list
 * Phase 03's own walk already produced. Every manifest read is guarded three ways: a
 * per-file size cap ({@link MAX_MANIFEST_BYTES}), a total-manifest-count cap
 * ({@link MAX_MANIFESTS_SCANNED}), and an {@link isHardIgnored} re-check (§2's vendored-
 * `package.json` guard — belt-and-suspenders, since `indexedFilePaths` should never
 * contain a hard-ignored path in the first place, but this module has no way to verify
 * that invariant holds for whatever produced its input).
 */
export async function buildRepoContext(
  rootDir: string,
  indexedFilePaths: readonly string[],
): Promise<RepoContext> {
  const files = new Set(indexedFilePaths);

  const candidateManifestPaths = indexedFilePaths.filter((p) => {
    if (isHardIgnored(p)) return false;
    const basename = path.posix.basename(p);
    return MANIFEST_BASENAMES.has(basename) || isTsconfigLike(basename);
  });

  const manifestScanTruncated =
    candidateManifestPaths.length > MAX_MANIFESTS_SCANNED;
  const scannedPaths = candidateManifestPaths.slice(0, MAX_MANIFESTS_SCANNED);

  let malformedManifestCount = 0;
  const packages: PackageManifest[] = [];
  const tsconfigs: TsconfigEntry[] = [];
  const manifestBytes = new Map<string, string | null>();
  const workspaceMarkers: WorkspaceMarkers = {
    pnpmWorkspaceYaml: false,
    npmWorkspacesField: false,
    nxJson: false,
    turboJson: false,
    goWork: false,
  };
  const workspaceGlobs: string[] = [];

  for (const manifestPath of scannedPaths) {
    const basename = path.posix.basename(manifestPath);
    const dir = dirOf(manifestPath);

    if (basename === "go.work") {
      workspaceMarkers.goWork = true;
      continue;
    }
    if (basename === "nx.json") {
      workspaceMarkers.nxJson = true;
      continue;
    }
    if (basename === "turbo.json") {
      workspaceMarkers.turboJson = true;
      continue;
    }

    const text = await fs
      .readFile(path.join(rootDir, manifestPath), "utf8")
      .catch(() => null);
    if (text === null) {
      malformedManifestCount += 1;
      continue;
    }

    if (basename === "pnpm-workspace.yaml") {
      workspaceMarkers.pnpmWorkspaceYaml = true;
      // A `pnpm-workspace.yaml` with no `packages:` key at all is a legitimate shape, not
      // a malformed one — the file's only real-world purpose here can be its
      // `allowBuilds` map, with nothing about `packages:` intended (found directly by
      // this prompt's own self-resolution dry run against this repository: `apps/web/
      // pnpm-workspace.yaml` is exactly this shape). Only an unreadable file counts as
      // malformed; an empty glob list is simply "declares no packages."
      const globs = parsePnpmWorkspaceYaml(text);
      workspaceGlobs.push(...globs);
      continue;
    }

    if (isTsconfigLike(basename)) {
      // Seed the extends-chain cache with the entry file's already-read text (bounded the
      // same way `mergeExtendsChain`'s own reads are) so it is never read from disk twice.
      manifestBytes.set(
        manifestPath,
        Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES ? null : text,
      );
      const { merged, entryReadable } = await mergeExtendsChain(
        rootDir,
        manifestPath,
        manifestBytes,
      );
      if (!entryReadable) {
        // The entry manifest itself (already read into `text` above) failed to parse as
        // JSONC — a genuinely malformed tsconfig, not merely an incomplete `extends`
        // chain. A tsconfig with no `baseUrl`/`paths` at all is still perfectly valid
        // (most are) and is never counted here.
        malformedManifestCount += 1;
        continue;
      }
      tsconfigs.push({
        dir,
        path: manifestPath,
        baseUrl: merged.baseUrl,
        paths: merged.paths,
      });
      continue;
    }

    // package.json
    const parsed = parseJsoncObject(text);
    if (parsed === null) {
      malformedManifestCount += 1;
      continue;
    }
    packages.push(parsePackageManifest(dir, manifestPath, parsed));
    if (readNpmWorkspacesField(parsed).length > 0) {
      workspaceMarkers.npmWorkspacesField = true;
      workspaceGlobs.push(...readNpmWorkspacesField(parsed));
    }
  }

  // Nearest-ancestor lookups (both tsconfigs and packages) need longest-directory-first
  // ordering — same convention as `walk-tree.ts`'s `derivePackageRoots`.
  tsconfigs.sort((a, b) => b.dir.length - a.dir.length);
  packages.sort((a, b) => b.dir.length - a.dir.length);

  const packageDirs = packages.map((p) => p.dir);
  const workspaceRoots =
    workspaceGlobs.length === 0
      ? []
      : [
          ...new Set(
            packageDirs.filter((dir) =>
              micromatch.isMatch(dir === "" ? "." : dir, workspaceGlobs),
            ),
          ),
        ].sort((a, b) => b.length - a.length);

  return {
    tsconfigs,
    workspaceRoots,
    packages,
    files,
    workspaceMarkers,
    malformedManifestCount,
    manifestScanTruncated,
  };
}

// ---------------------------------------------------------------------------
// Lookups the resolvers (and prompt 4) need against a built RepoContext
// ---------------------------------------------------------------------------

/** Nearest-ancestor tsconfig for `filePath` — the reasonable, documented answer to "which
 * tsconfig applies to a given file" (§0's own framing of this as an open question). A
 * `paths`/`baseUrl` declared in a *sibling* package's tsconfig, or a repository with no
 * tsconfig at all, correctly yields `null` — the import-resolver's own fallback to
 * relative-only resolution. */
export function findTsconfigForFile(
  context: RepoContext,
  filePath: string,
): TsconfigEntry | null {
  const dir = dirOf(filePath);
  let best: TsconfigEntry | null = null;
  for (const entry of context.tsconfigs) {
    if (
      entry.dir !== "" &&
      dir !== entry.dir &&
      !dir.startsWith(`${entry.dir}/`)
    )
      continue;
    // Longest matching directory wins regardless of the array's own order — correctness
    // here must not depend on `buildRepoContext` having sorted `tsconfigs` first (it
    // does, for its own O(n) construction reasons, but a public lookup function should
    // not silently break if a caller ever hands it an unsorted list, e.g. a hand-built
    // test fixture).
    if (best === null || entry.dir.length > best.dir.length) best = entry;
  }
  return best;
}

/** Nearest-ancestor `package.json` for `filePath`, or `null` when none exists at all
 * (a repository with no `package.json` anywhere above this file). Longest-matching-
 * directory wins regardless of `context.packages`'s own order — see
 * {@link findTsconfigForFile}'s own comment on why this does not rely on caller sorting. */
export function findPackageForFile(
  context: RepoContext,
  filePath: string,
): PackageManifest | null {
  const dir = dirOf(filePath);
  let best: PackageManifest | null = null;
  for (const pkg of context.packages) {
    if (pkg.dir !== "" && dir !== pkg.dir && !dir.startsWith(`${pkg.dir}/`))
      continue;
    if (best === null || pkg.dir.length > best.dir.length) best = pkg;
  }
  return best;
}

/**
 * The `packageName` upgrade §2 of this prompt's spec describes: the file's owning
 * package's declared `"name"`, falling back to that package's own directory path when it
 * has no declared name, falling back to `null` when no ancestor `package.json` exists at
 * all. Matches `file-classifier.ts`'s `detectPackageName` contract exactly for the
 * fallback case, so upgrading a `RepositoryFile.packageName` value with this function's
 * result (prompt 4's job) never needs a schema change — it either keeps the same
 * directory-path value or improves it to a real package name.
 */
export function getPackageNameForFile(
  context: RepoContext,
  filePath: string,
): string | null {
  const pkg = findPackageForFile(context, filePath);
  if (!pkg) return null;
  return pkg.name ?? pkg.dir;
}
