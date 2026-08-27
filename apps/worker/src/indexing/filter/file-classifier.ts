import path from "node:path";
import type { FileClassification } from "@repo/shared";

/**
 * Step 4 of `plan.md` §8.2, the last three stages: size cap → binary detection →
 * minified heuristic — plus the classification/language/isTest/isGenerated/packageName
 * fields every surviving row needs. Everything here is deterministic (§3's scope guard:
 * "the deterministic parts of file-classifier needed to mark files SKIPPED with a reason
 * at index time") — extension mapping and path/filename conventions only, nothing
 * language-aware, no parsing. That starts in Phase 04.
 *
 * This module does no filesystem I/O itself. `checkSizeCap` takes a size the caller
 * already has from `fs.stat`; `detectBinary`/`detectMinified` take buffers the caller
 * already read (once, for hashing — see indexer.service.ts). Keeping I/O out of this
 * module is what makes it fast to unit-test at the boundary cases (§14/§22).
 */

// ---------------------------------------------------------------------------
// Size cap
// ---------------------------------------------------------------------------

/** §10/§19: 512 KB. A file at or under the cap proceeds to binary/minified detection; a
 * file over it is `SKIPPED_TOO_LARGE`. */
export const SIZE_CAP_BYTES = 512 * 1024;

export function isOverSizeCap(sizeBytes: number): boolean {
  return sizeBytes > SIZE_CAP_BYTES;
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

/** §10: a NUL byte anywhere in the first 8 KB. Bounded read — the caller passes at most
 * this many bytes, never the whole file, matching §4's "never load the whole tree into
 * memory" for the classification path specifically (the *hashing* path is a separate,
 * necessarily-unbounded read — see indexer.service.ts's own comment on why). */
export const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * `sniffedBytes` must be at most {@link BINARY_SNIFF_BYTES} — the caller's
 * responsibility, since this function has no way to bound a read it never performs.
 * A NUL byte is a strong, cheap binary signal: legitimate UTF-8/ASCII/Latin-1 source
 * text never contains one; UTF-16 text (rare in source repositories, but real) does,
 * which is a known, accepted false positive — see §22 and this module's header on the
 * deliberate bias.
 */
export function detectBinary(sniffedBytes: Buffer): boolean {
  return sniffedBytes.includes(0);
}

// ---------------------------------------------------------------------------
// Minified heuristic
// ---------------------------------------------------------------------------

/** §10: average line length over 500 characters. */
export const MINIFIED_AVERAGE_LINE_LENGTH = 500;

/**
 * A single very long line (e.g. one long JSON array on one line, or a data URI embedded
 * in a source file) must not trip this on its own — it is the *average* over the whole
 * file, not the max of any one line, matching §14's own boundary case ("a file with one
 * very long line vs a genuinely minified bundle"). A zero-line (empty) file is never
 * minified — `lines.length === 0` short-circuits to `false` rather than dividing by zero.
 */
export function detectMinified(content: Buffer): boolean {
  const text = content.toString("utf8");
  if (text.length === 0) return false;

  // Trailing newline produces one empty trailing segment that would otherwise drag the
  // average down and mask a genuinely minified file whose last line is its longest.
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return false;

  const totalLength = lines.reduce((sum, line) => sum + line.length, 0);
  return totalLength / lines.length > MINIFIED_AVERAGE_LINE_LENGTH;
}

// ---------------------------------------------------------------------------
// Line counting — a cheap, separate concern from the minified heuristic above
// ---------------------------------------------------------------------------

/** Counts newline-delimited lines the same way `detectMinified` does (trailing-newline
 * segment excluded), so `RepositoryFile.lineCount` and the minified heuristic agree on
 * what "a line" means for the same file. */
export function countLines(content: Buffer): number {
  const text = content.toString("utf8");
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

// ---------------------------------------------------------------------------
// Language, from extension only — never guessed from content (§2's own instruction)
// ---------------------------------------------------------------------------

/** Extension (including the leading dot, lowercased) → language name. Extend this map,
 * and only this map, to recognize another extension — same "one place, data" discipline
 * as `HARD_IGNORE_PATTERNS` in ignore-rules.ts. */
const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".swift": "swift",
  ".scala": "scala",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".sql": "sql",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".vue": "vue",
  ".svelte": "svelte",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".mdx": "markdown",
  ".proto": "protobuf",
  ".graphql": "graphql",
  ".gql": "graphql",
};

/** `null` when the extension is unrecognized — never guessed from content (§2). */
export function detectLanguage(relativePath: string): string | null {
  const ext = path.extname(relativePath).toLowerCase();
  return EXTENSION_LANGUAGE[ext] ?? null;
}

// ---------------------------------------------------------------------------
// isTest / isGenerated — path and filename conventions only
// ---------------------------------------------------------------------------

const TEST_PATH_SEGMENT = /(^|\/)(__tests__|tests?|spec)(\/|$)/i;
const TEST_FILENAME = /[.\-_](test|spec)\.[^/.]+$/i;

/** Conventional path (`__tests__/`, `test/`, `tests/`, `spec/`) or filename
 * (`*.test.ts`, `*.spec.ts`, `*_test.py`, `*-test.js`) markers. Deliberately loose — a
 * false positive here (a non-test file under a `tests/` fixtures directory, say) costs
 * nothing but a slightly-wrong flag on one row; a false negative costs a real test file
 * being treated as production code by a later phase's review weighting. */
export function detectIsTest(relativePath: string): boolean {
  return (
    TEST_PATH_SEGMENT.test(relativePath) || TEST_FILENAME.test(relativePath)
  );
}

const GENERATED_FILENAME = /\.(generated|gen|pb)\.[^/.]+$/i;
const GENERATED_PATH_SEGMENT = /(^|\/)(generated|\.generated)(\/|$)/i;

/**
 * The `isGenerated` **column** is a separate signal from `.gitattributes`-driven
 * `SKIPPED_GENERATED` (ignore-rules.ts) — a file can be conventionally-named generated
 * code (`schema.generated.ts`, a `generated/` directory) without the repository ever
 * declaring so in `.gitattributes`, and such a file is still `INDEXED` (it is real,
 * readable source that Phase 04 will parse), just flagged. The two signals are computed
 * independently and never reconciled against each other in this phase.
 */
export function detectIsGenerated(relativePath: string): boolean {
  return (
    GENERATED_FILENAME.test(relativePath) ||
    GENERATED_PATH_SEGMENT.test(relativePath)
  );
}

// ---------------------------------------------------------------------------
// packageName — monorepo package detection, kept deliberately shallow this phase
// ---------------------------------------------------------------------------

/**
 * Finds the nearest ancestor directory (by longest matching prefix) that is a known
 * package root, and returns the `path.dirname` of the file relative to nothing —
 * actually returns the package root's own relative path, which is what
 * `RepositoryFile.packageName` stores (§7 of the decision log: a files-only phase does
 * not attempt npm/cargo/go workspace *name* resolution — reading and parsing every
 * `package.json` for its `"name"` field is Phase 04-adjacent work this phase does not
 * need; the directory path is a sufficient, correct grouping key for
 * `@@index([repositoryId, packageName])` today, and Phase 04's monorepo work can upgrade
 * it to the parsed package name without a schema change).
 *
 * `packageRoots` must be pre-sorted longest-first by the caller (indexer.service.ts
 * builds it once per repository, not per file) so the first prefix match found here is
 * always the nearest one, not merely *a* matching one.
 */
export function detectPackageName(
  relativePath: string,
  packageRootsLongestFirst: readonly string[],
): string | null {
  const dir = path.dirname(relativePath);
  for (const root of packageRootsLongestFirst) {
    if (root === "." ? true : dir === root || dir.startsWith(`${root}/`)) {
      return root;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// classification — the coarse FileClassification enum
// ---------------------------------------------------------------------------

const CONFIG_FILENAME =
  /^(\.[\w-]+rc(\.[a-z]+)?|[\w.-]+\.config\.[cm]?[jt]sx?|tsconfig.*\.json|package\.json|\.env(\..+)?|Dockerfile|docker-compose.*\.ya?ml|\.editorconfig|\.eslintrc.*|\.prettierrc.*)$/i;
const CONFIG_EXTENSIONS = new Set([".yaml", ".yml", ".toml", ".ini", ".cfg"]);
const DEPENDENCY_LOCK_FILENAME =
  /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock)$/;
const DOCUMENTATION_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt"]);
const ASSET_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".pdf",
  ".zip",
  ".woff",
  ".woff2",
  ".ttf",
  ".mp4",
  ".wasm",
]);

/**
 * Coarse, deterministic bucket for `RepositoryFile.classification` (§6's `FileClassification`
 * enum). Checked in a fixed priority order — a `package-lock.json` is a dependency lock
 * *and* would otherwise match nothing else, a `README.md` is documentation, a `.eslintrc.json`
 * is config even though its extension is `.json`. Anything left over after every specific
 * check is `SOURCE` if it has a recognized language, else `UNKNOWN` — never guessed.
 */
export function classifyFile(
  relativePath: string,
  isTest: boolean,
  isGenerated: boolean,
  language: string | null,
): FileClassification {
  const filename = path.basename(relativePath);
  const ext = path.extname(relativePath).toLowerCase();

  if (DEPENDENCY_LOCK_FILENAME.test(filename)) return "DEPENDENCY_LOCK";
  if (isTest) return "TEST";
  if (isGenerated) return "GENERATED";
  if (DOCUMENTATION_EXTENSIONS.has(ext)) return "DOCUMENTATION";
  if (ASSET_EXTENSIONS.has(ext)) return "ASSET";
  if (CONFIG_FILENAME.test(filename) || CONFIG_EXTENSIONS.has(ext))
    return "CONFIG";
  if (language !== null) return "SOURCE";
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// The combined per-file classification result
// ---------------------------------------------------------------------------

export type ClassifierSkipReason =
  "SKIPPED_TOO_LARGE" | "SKIPPED_BINARY" | "SKIPPED_MINIFIED";

export type ClassifierDecision =
  | { skip: true; reason: ClassifierSkipReason }
  | {
      skip: false;
      classification: FileClassification;
      language: string | null;
      isTest: boolean;
      isGenerated: boolean;
      packageName: string | null;
    };

/**
 * Runs the size-cap check first — a `fs.stat` size, no read required — then, only for
 * files at or under the cap, the binary sniff. `content` is the *whole* file (already
 * read by the caller for hashing — see indexer.service.ts) and is used only for the
 * minified check and line count; the binary sniff uses `content.subarray(0,
 * BINARY_SNIFF_BYTES)` rather than re-reading, since the caller already paid for the
 * read and a second, partial read of the same file would be pure waste.
 *
 * **Bias, per §22**: a binary file that slips past `detectBinary` (e.g. UTF-16 text
 * with no NUL in the first 8 KB by chance) still gets indexed and later mis-parsed by
 * Phase 04, which re-checks — a contained, recoverable mistake. A text file wrongly
 * flagged binary disappears from review context entirely, silently, with nothing to
 * re-check it. Given that asymmetry, this module does not add any check whose false-positive
 * side is "wrongly SKIPPED" beyond the two the phase document names explicitly
 * (NUL-byte sniff, average-line-length) — no additional heuristic is layered on top,
 * however tempting, without a comparably strong signal.
 */
export function classify(
  relativePath: string,
  sizeBytes: number,
  content: Buffer,
  packageRootsLongestFirst: readonly string[],
): ClassifierDecision {
  if (isOverSizeCap(sizeBytes)) {
    return { skip: true, reason: "SKIPPED_TOO_LARGE" };
  }

  if (detectBinary(content.subarray(0, BINARY_SNIFF_BYTES))) {
    return { skip: true, reason: "SKIPPED_BINARY" };
  }

  if (detectMinified(content)) {
    return { skip: true, reason: "SKIPPED_MINIFIED" };
  }

  const language = detectLanguage(relativePath);
  const isTest = detectIsTest(relativePath);
  const isGenerated = detectIsGenerated(relativePath);
  const packageName = detectPackageName(relativePath, packageRootsLongestFirst);
  const classification = classifyFile(
    relativePath,
    isTest,
    isGenerated,
    language,
  );

  return {
    skip: false,
    classification,
    language,
    isTest,
    isGenerated,
    packageName,
  };
}
