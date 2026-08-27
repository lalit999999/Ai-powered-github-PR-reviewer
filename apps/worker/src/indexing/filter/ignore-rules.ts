import micromatch from "micromatch";

/**
 * Step 4 of `plan.md` §8.2, the first two stages: hard-ignore globs, then
 * `.gitattributes` `linguist-generated`/`linguist-vendored`. The remaining stages of
 * step 4 (size cap, binary detection, minified heuristic) are file-classifier.ts's job —
 * this module only ever decides "no row" or "a row with one of two specific skip
 * reasons", never `SKIPPED_TOO_LARGE`/`SKIPPED_BINARY`/`SKIPPED_MINIFIED`.
 *
 * ## The order is load-bearing, and it is encoded as a single function, not left implicit
 *
 * §10's filter order is: hard-ignore globs → `.gitattributes` → size cap → binary
 * detection → minified heuristic. {@link classifyIgnore} below runs exactly the first
 * two stages, in that order, and returns a result the caller (indexer.service.ts) uses
 * to decide whether file-classifier.ts's later stages ever run at all.
 *
 * ## Two different "skip", on purpose — get this backwards and §14's DB check breaks
 *
 * - **Hard-ignore match → no `RepositoryFile` row at all.** `node_modules/**`,
 *   `.git/**`, build output, lockfiles: these are *structural* exclusions. A
 *   committed-`node_modules` monorepo can be 90% of a repository's raw file count
 *   (`plan.md` §43.2) — giving every one of those files a `SKIPPED` row would multiply
 *   the write volume for zero benefit; nothing downstream ever needs to know
 *   `node_modules/lodash/index.js` specifically existed and was skipped.
 * - **A `.gitattributes` `linguist-generated`/`linguist-vendored` match → a row, with
 *   `indexState=SKIPPED` and `skipReason=SKIPPED_GENERATED`/`SKIPPED_VENDORED`.** This is
 *   a targeted, per-file signal a repository maintainer wrote on purpose (e.g. "this one
 *   generated protobuf file, not the whole directory"), and unlike hard-ignore it is
 *   *data*, not structure — the PR pipeline (per §4 FR) needs to know the file exists
 *   and why it wasn't indexed, the same reasoning that gives every other skip stage a row.
 *
 * A reader "fixing" this by giving hard-ignored paths a row, or by silently dropping
 * `.gitattributes` matches, would both look like reasonable cleanups and both break the
 * §14 Database Verification invariant ("hard-ignored paths never get a row at all — only
 * files that reach the hashing step get one"). Recorded here, not just in the decision
 * log, because this is exactly the kind of thing a later reader edits without noticing.
 */

// ---------------------------------------------------------------------------
// Hard-ignore — one list, in one place (§16: extensible without re-derivation)
// ---------------------------------------------------------------------------

/**
 * `plan.md` §8.2 step 4's own `HARD_IGNORE` array, reproduced verbatim. Extend this
 * array — and only this array — to add a new hard-ignore rule; nothing else in this
 * module encodes glob knowledge.
 */
export const HARD_IGNORE_PATTERNS: readonly string[] = [
  // Dependency directories
  "node_modules/**",
  ".git/**",
  "vendor/**",
  // Build output
  "dist/**",
  "build/**",
  "out/**",
  ".next/**",
  "target/**",
  "__pycache__/**",
  "coverage/**",
  ".venv/**",
  // Minified / map / bundle files
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.bundle.js",
  // Lockfiles
  "**/*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "go.sum",
  "Cargo.lock",
  "poetry.lock",
  "composer.lock",
  // Snapshots
  "**/*.snap",
  "**/__snapshots__/**",
  // Binary/asset extensions
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.svg",
  "**/*.ico",
  "**/*.pdf",
  "**/*.zip",
  "**/*.woff*",
  "**/*.ttf",
  "**/*.mp4",
  "**/*.wasm",
];

/**
 * Compiled once at module load, not per path. A full index walks up to
 * `INDEX_MAX_FILE_COUNT` (default 200,000) paths — re-parsing ~40 glob strings into
 * regexes on every one of them would mean millions of avoidable parses. `micromatch`'s
 * own `makeRe` is the seam that lets "compile once" be literal rather than a hope that
 * `isMatch`'s internal cache behaves the way this comment assumes.
 */
const HARD_IGNORE_REGEXES: readonly RegExp[] = HARD_IGNORE_PATTERNS.map(
  (pattern) => micromatch.makeRe(pattern, { dot: true }) as RegExp,
);

/** True if `relativePath` (repository-relative, forward-slash-separated — the shape
 * archive-extractor.ts's `onExtracted` callback paths are already in) matches any
 * hard-ignore pattern. Short-circuits on the first match; pattern order does not matter
 * for correctness, only for average-case speed (broad directory globs first). */
export function isHardIgnored(relativePath: string): boolean {
  for (const regex of HARD_IGNORE_REGEXES) {
    if (regex.test(relativePath)) return true;
  }
  return false;
}

/**
 * Whether a **directory** can be pruned — skipped without ever descending into it —
 * rather than merely having its files rejected one at a time. A performance
 * optimization for §21/§22's committed-`node_modules` case, not a new exclusion rule:
 * every directory-anchored pattern in {@link HARD_IGNORE_PATTERNS}
 * (`node_modules/**`, `.git/**`, `vendor/**`, `dist/**`, `build/**`, `out/**`,
 * `.next/**`, `target/**`, `__pycache__/**`, `coverage/**`, `.venv/**`,
 * `**\/__snapshots__/**`) matches *any* path under that directory, so testing one
 * synthetic child path against the same compiled pattern set {@link isHardIgnored}
 * already uses correctly answers "would everything under here be hard-ignored anyway".
 *
 * This cannot false-positive-prune a directory because of an extension-anchored
 * pattern (`**\/*.min.js` and friends): the synthetic probe name carries no extension,
 * so only a directory-anchored pattern can ever match it. Without this, indexer.service.ts
 * would still walk every file inside a committed `node_modules` tree only to reject each
 * one individually — on a monorepo where that can be 90% of the raw file count, the
 * difference is walking hundreds of thousands of directory entries versus walking past
 * one.
 */
export function isHardIgnoredDirectory(relativeDirPath: string): boolean {
  return isHardIgnored(`${relativeDirPath}/__phase03_prune_probe__`);
}

// ---------------------------------------------------------------------------
// .gitattributes — linguist-generated / linguist-vendored
// ---------------------------------------------------------------------------

export type GitattributesFlag = "GENERATED" | "VENDORED";

export interface GitattributesRule {
  regex: RegExp;
  flag: GitattributesFlag;
  /** `linguist-generated` (bare or `=true`) is `true`; `-linguist-generated` or
   * `linguist-generated=false` is `false`, which *unsets* an earlier pattern's match for
   * paths this more-specific rule also covers — real `.gitattributes` semantics: the
   * last matching pattern for a given attribute wins, not the first. */
  value: boolean;
}

const ATTRIBUTE_NAMES: Record<string, GitattributesFlag> = {
  "linguist-generated": "GENERATED",
  "linguist-vendored": "VENDORED",
};

/**
 * Real `.gitattributes` (like `.gitignore`) treats a pattern with no interior `/` as
 * unanchored — it matches at any depth, as if written with a `**` prefix segment. A
 * pattern that *does* contain a `/` (other than a single trailing one) is anchored to
 * the `.gitattributes` file's own directory. `micromatch` has no such implicit rule (a
 * bare `*.pb.go` only matches a top-level file for it), so that git-specific
 * normalization is applied here, once, before compiling — otherwise the single most
 * common real-world `.gitattributes` line shape (`*.min.js linguist-generated`, no
 * leading wildcard-slash prefix) would silently never match anything below the
 * repository root.
 */
function toAnchoredGlob(pattern: string): string {
  const withoutTrailingSlash = pattern.endsWith("/")
    ? pattern.slice(0, -1)
    : pattern;
  return withoutTrailingSlash.includes("/") ? pattern : `**/${pattern}`;
}

/**
 * Parses the subset of `.gitattributes` this phase cares about: `linguist-generated`
 * and `linguist-vendored` only (§10). Every other attribute (`linguist-language`,
 * `text`, `eol`, …) is ignored — this is not a general `.gitattributes` parser, and
 * pretending otherwise would be scope creep with no consumer.
 *
 * Line shape: `<pattern> <attr>[=<value>]...`, one or more space-separated attributes.
 * `-attr` is shorthand for `attr=false`. Blank lines and `#`-comments are skipped.
 */
export function parseGitattributes(content: string): GitattributesRule[] {
  const rules: GitattributesRule[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const [pattern, ...attributeTokens] = line.split(/\s+/);
    if (!pattern) continue;

    for (const token of attributeTokens) {
      const negated = token.startsWith("-");
      const body = negated ? token.slice(1) : token;
      const [name, rawValue] = body.split("=");
      const flag = name ? ATTRIBUTE_NAMES[name] : undefined;
      if (!flag) continue; // not an attribute this module tracks

      const value = negated ? false : rawValue !== "false";
      const regex = micromatch.makeRe(toAnchoredGlob(pattern), {
        dot: true,
      }) as RegExp;
      rules.push({ regex, flag, value });
    }
  }

  return rules;
}

/**
 * Applies parsed `.gitattributes` rules to one path. Iterates every rule in file order
 * and keeps the **last** match per flag (not the first, and not "most specific wins" —
 * matching real git attribute-resolution semantics, where a later line in the file
 * overrides an earlier one for paths both patterns cover).
 *
 * Returns `null` when neither flag is set to `true` by the last matching rule for it —
 * the common case, since most repositories have no `.gitattributes` at all (an empty
 * `rules` array is the fast path: the loop below simply never runs).
 */
export function classifyGitattributes(
  relativePath: string,
  rules: readonly GitattributesRule[],
): GitattributesFlag | null {
  let generated: boolean | null = null;
  let vendored: boolean | null = null;

  for (const rule of rules) {
    if (!rule.regex.test(relativePath)) continue;
    if (rule.flag === "GENERATED") generated = rule.value;
    else vendored = rule.value;
  }

  // Generated takes priority when a path is (unusually) flagged as both — it is the
  // stronger claim ("do not even attribute this to a human") and the more common of the
  // two skip reasons in practice.
  if (generated === true) return "GENERATED";
  if (vendored === true) return "VENDORED";
  return null;
}

// ---------------------------------------------------------------------------
// The combined decision — the only thing indexer.service.ts calls
// ---------------------------------------------------------------------------

export type IgnoreDecision =
  | { kind: "HARD_IGNORE" }
  | { kind: "SKIP"; reason: "SKIPPED_GENERATED" | "SKIPPED_VENDORED" }
  | { kind: "KEEP" };

/**
 * Runs the first two stages of §10's filter order, in order, and returns one decision.
 * `KEEP` means "pass to file-classifier.ts's size/binary/minified stages" — this
 * function has no opinion on those.
 */
export function classifyIgnore(
  relativePath: string,
  gitattributesRules: readonly GitattributesRule[],
): IgnoreDecision {
  if (isHardIgnored(relativePath)) return { kind: "HARD_IGNORE" };

  const flag = classifyGitattributes(relativePath, gitattributesRules);
  if (flag === "GENERATED")
    return { kind: "SKIP", reason: "SKIPPED_GENERATED" };
  if (flag === "VENDORED") return { kind: "SKIP", reason: "SKIPPED_VENDORED" };

  return { kind: "KEEP" };
}
