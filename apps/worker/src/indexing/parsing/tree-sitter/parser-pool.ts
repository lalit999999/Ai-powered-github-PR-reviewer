import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser, type Tree } from "web-tree-sitter";

/**
 * Owns the tree-sitter runtime: grammar loading, `Parser` instances, and tree
 * lifetime. Knows nothing about repositories, files-on-disk, Prisma, or Inngest — those
 * are Prompt 2/3/4's job. `content` in, a `Tree` lent to a callback, out.
 *
 * ## Binding: `web-tree-sitter` (WASM), not native `tree-sitter`
 *
 * See docs/decisions/phase-04-log.md for the full argument and the empirical grammar-load
 * proof. In short: one binding across dev/CI/`node:22-slim` Docker, no `node-gyp`, no
 * compiler toolchain in `Dockerfile.worker` — `.wasm` files ride along with the existing
 * `pnpm install --prod` layer with no Dockerfile change.
 *
 * ## No repository code is ever executed
 *
 * `Parser.parse()` only ever produces a syntax tree from text — this module never
 * `require`s, `import()`s, `eval`s, or shells out to anything derived from repository
 * content (phase-04 prompt-1 §1 rule 1; `plan.md` §35.6).
 *
 * ## Tree disposal is mandatory, not advisory
 *
 * `plan.md` §45 names undisposed trees as this phase's specific memory-leak failure
 * point. {@link withParsedTree} is the *only* way to obtain a tree from this module —
 * there is no function that returns a live `Tree` to its caller. The tree is lent to
 * `use` and deleted in a `finally` regardless of `use`'s outcome, mirroring
 * `extractRepositoryArchive`'s own callback-cleanup contract
 * (apps/worker/src/indexing/fetcher/archive-extractor.ts) for the identical reason: a
 * function that *returns* a resource makes leaking it the default; a function that lends
 * it inside a `finally` makes leaking it structurally impossible. **Do not add a
 * function that returns a `Tree` to a caller** — extract whatever data `use` needs into
 * plain objects before returning.
 */

export type ParserLanguage = "typescript" | "tsx" | "javascript";

// ---------------------------------------------------------------------------
// Extension -> language mapping
// ---------------------------------------------------------------------------

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, ParserLanguage>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

/**
 * Maps a file path to the grammar that should parse it, or `null` if it is not
 * parse-eligible (phase-04 §3: TypeScript/JavaScript scope only for the MVP — Python and
 * Go are explicitly V2). Extension only, matching `file-classifier.ts`'s own
 * `detectLanguage` convention — never guessed from content.
 */
export function selectLanguage(filePath: string): ParserLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

// ---------------------------------------------------------------------------
// Grammar loading — resolved from node_modules, never a hardcoded relative path
// ---------------------------------------------------------------------------

/**
 * `apps/worker/tsconfig.json` compiles `src/**` to `dist/` with `tsc` alone — no asset
 * copy step — so a path relative to *this compiled file's own location* would resolve
 * differently in `src/` (run via `tsx`/vitest) than in `dist/` (what `Dockerfile.worker`
 * actually ships). Resolving through `node_modules` via `createRequire` is location-
 * independent: it works identically from `src/` or `dist/`, exactly as an ordinary
 * `import "tree-sitter-typescript"` would, just without loading JS.
 */
const require = createRequire(import.meta.url);

const GRAMMAR_WASM_SPECIFIERS: Readonly<Record<ParserLanguage, string>> = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
};

// ---------------------------------------------------------------------------
// Runtime + grammar + parser memoization — one of each per process
// ---------------------------------------------------------------------------

/**
 * `Parser.init()` loads and instantiates the WASM runtime — expensive, and must only
 * ever run once per process. A module-level memoized promise (not a boolean flag guarding
 * a fire-and-forget call) means concurrent callers all await the *same* in-flight
 * initialization instead of racing two `Parser.init()` calls.
 */
let initPromise: Promise<void> | null = null;

function ensureInitialized(): Promise<void> {
  initPromise ??= Parser.init();
  return initPromise;
}

const languagePromises = new Map<ParserLanguage, Promise<Language>>();

function loadLanguage(language: ParserLanguage): Promise<Language> {
  const existing = languagePromises.get(language);
  if (existing) return existing;

  const promise = (async () => {
    await ensureInitialized();
    const wasmPath = require.resolve(GRAMMAR_WASM_SPECIFIERS[language]);
    return Language.load(wasmPath);
  })();
  languagePromises.set(language, promise);
  return promise;
}

const parserPromises = new Map<ParserLanguage, Promise<Parser>>();

function getParser(language: ParserLanguage): Promise<Parser> {
  const existing = parserPromises.get(language);
  if (existing) return existing;

  const promise = (async () => {
    const grammar = await loadLanguage(language);
    const parser = new Parser();
    parser.setLanguage(grammar);
    return parser;
  })();
  parserPromises.set(language, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// The pathological-input guard
// ---------------------------------------------------------------------------

/**
 * 2 MiB — four times `file-classifier.ts`'s `SIZE_CAP_BYTES` (512 KB), the cap that
 * already keeps everything the real indexing pipeline hands this module well under this
 * limit in practice. Set independently and explicitly anyway, rather than trusting the
 * caller to have applied that cap: this module has no way to know whether a given caller
 * is the real pipeline or a future one-off/test/debug-panel invocation. tree-sitter
 * parses at roughly 10–50 MB/s (`plan.md` §10.1), so 2 MiB bounds worst-case parse time
 * to well under a second — long enough for genuinely large legitimate files, short
 * enough that a single adversarial input cannot meaningfully stall the worker.
 */
export const MAX_PARSE_CONTENT_BYTES = 2 * 1024 * 1024;

export class ContentTooLargeError extends Error {
  readonly byteLength: number;
  constructor(byteLength: number) {
    super(`content is ${byteLength.toString()} bytes, exceeding the ${MAX_PARSE_CONTENT_BYTES.toString()}-byte parser-pool guard`);
    this.name = "ContentTooLargeError";
    this.byteLength = byteLength;
  }
}

// ---------------------------------------------------------------------------
// Outstanding-tree accounting — what the leak test asserts against
// ---------------------------------------------------------------------------

let outstandingTreeCount = 0;

/** Test-only visibility into whether every tree this module has lent out has also been
 * disposed. Not used by any production code path. */
export function getOutstandingTreeCount(): number {
  return outstandingTreeCount;
}

// ---------------------------------------------------------------------------
// The one way to obtain a tree
// ---------------------------------------------------------------------------

/**
 * Parses `content` with `language`'s grammar and hands the resulting tree to `use`,
 * deleting it in a `finally` regardless of whether `use` returns or throws. The tree
 * must never escape this callback — extract whatever `use` needs into plain data before
 * returning.
 *
 * Throws {@link ContentTooLargeError} before parsing if `content` exceeds
 * {@link MAX_PARSE_CONTENT_BYTES}. Callers that need a per-file soft failure (phase-04
 * prompt-1 §1 rule 4) catch this alongside any parse error and set `parseState=FAILED` —
 * this module does not know about `RepositoryFile` and cannot do that itself.
 */
export async function withParsedTree<T>(language: ParserLanguage, content: string, use: (tree: Tree) => T): Promise<T> {
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_PARSE_CONTENT_BYTES) {
    throw new ContentTooLargeError(byteLength);
  }

  const parser = await getParser(language);
  const tree = parser.parse(content);
  if (tree === null) {
    // parser.parse() only returns null if no language was ever assigned, or a progress
    // callback aborted the parse — getParser() always calls setLanguage(), and this
    // module never passes a progress callback. Structurally unreachable; the library's
    // own return type is nullable regardless, so this must still be handled rather than
    // asserted away with a non-null assertion.
    throw new Error(`web-tree-sitter returned no tree for language "${language}" — this should be unreachable`);
  }

  outstandingTreeCount += 1;
  try {
    return use(tree);
  } finally {
    tree.delete();
    outstandingTreeCount -= 1;
  }
}

// ---------------------------------------------------------------------------
// Parse-error reporting — tree-sitter is error-tolerant; a "failure" is a judgment call
// ---------------------------------------------------------------------------

export interface ParseErrorInfo {
  /** `tree.rootNode.hasError` — true if the tree contains an ERROR or MISSING node
   * anywhere, even a single one deep in an otherwise-fine file. */
  hasError: boolean;
  /**
   * Count of synthetic recovery nodes tree-sitter inserted to cope with unparseable
   * input — both genuine `ERROR` nodes (content that fit no rule at all) **and**
   * `MISSING` nodes (a required token the parser inserted a placeholder for, most
   * commonly an unbalanced/truncated closing brace) — a coarser, more actionable signal
   * than `hasError` alone for Prompt 2's tolerance-threshold decision (deliberately not
   * made here).
   *
   * **Prompt 2 finding, fixed here rather than worked around in the adapter**: this
   * count originally tracked `ERROR` nodes only. A truncated file with two missing
   * closing braces — arguably the single most common real-world "malformed file" shape
   * (`plan.md` §14's own "Failure Verification" scenario) — produces **zero** `ERROR`
   * nodes and two `MISSING` ones; `hasError` correctly reports `true` for it, but the
   * old `errorNodeCount` reported `0`, silently breaking the invariant that
   * `hasError === (errorNodeCount > 0)` and making Prompt 2's whole tolerance-ratio
   * policy blind to exactly the failure case it exists to catch (caught by this
   * prompt's own golden-file test against a deliberately truncated fixture — see
   * docs/decisions/phase-04-log.md). Counting both restores that invariant and makes
   * the signal match what `hasError` already promised.
   */
  errorNodeCount: number;
}

/**
 * Walks `tree` with a {@link TreeCursor}, iteratively (never recursively) — repository
 * content is attacker-controlled (`plan.md` §13), and a recursive walk over an
 * adversarially deep syntax tree could exhaust the call stack. Must be called with the
 * tree still live (i.e. from inside a {@link withParsedTree} callback).
 */
export function getParseErrorInfo(tree: Tree): ParseErrorInfo {
  const hasError = tree.rootNode.hasError;
  let errorNodeCount = 0;

  const cursor = tree.walk();
  try {
    let visitedChildren = false;
    for (;;) {
      if (!visitedChildren) {
        if (cursor.nodeType === "ERROR" || cursor.nodeIsMissing) errorNodeCount += 1;
        if (cursor.gotoFirstChild()) continue;
      }
      if (cursor.gotoNextSibling()) {
        visitedChildren = false;
        continue;
      }
      if (!cursor.gotoParent()) break;
      visitedChildren = true;
    }
  } finally {
    cursor.delete();
  }

  return { hasError, errorNodeCount };
}

// ---------------------------------------------------------------------------
// Test teardown
// ---------------------------------------------------------------------------

/**
 * Deletes every cached `Parser` instance and clears the parser cache — test-only, called
 * between test files so one file's parsers don't leak into another's memory accounting.
 * Deliberately does **not** clear the loaded-`Language` cache or reset `initPromise`:
 * `Parser.init()` must only ever run once per process, and `Language` objects are
 * immutable and cheap to keep around — only `Parser` instances are worth reclaiming.
 */
export async function disposeAll(): Promise<void> {
  const parsers = await Promise.all(parserPromises.values());
  for (const parser of parsers) parser.delete();
  parserPromises.clear();
}
