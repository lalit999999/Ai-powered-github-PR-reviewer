import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createLogger, type Logger } from "@repo/observability";
import type { DependencyKind, IndexState, ParseState, SymbolKind } from "@repo/shared";
import { isParseRefusal, parseFile } from "../parsing/adapters/typescript.adapter.js";
import type { ParsedExport, ParsedImport, ParsedSymbol } from "../parsing/parsed-file.types.js";
import { selectLanguage, type ParserLanguage } from "../parsing/tree-sitter/parser-pool.js";
import {
  deleteCodeDependenciesByRepository,
  insertCodeDependencies,
  type CodeDependencyInsertInput,
  type InsertedCountsByKind,
} from "../persistence/code-dependency.repository.js";
import { deleteCodeSymbolsByRepository, insertCodeSymbols, type CodeSymbolInsertInput } from "../persistence/code-symbol.repository.js";
import {
  CALL_AMBIGUITY_MAX_CANDIDATES,
  CALL_CONFIDENCE_AMBIGUOUS_BASE,
  CALL_CONFIDENCE_NAMED_IMPORT,
  CALL_CONFIDENCE_SAME_FILE,
  CALL_CONFIDENCE_UNIQUE_REPO_MATCH,
  resolveCalls,
  type CallResolverFileInput,
  type CallResolverSymbol,
} from "./call-resolver.js";
import { resolveImport, type ImportResolution } from "./import-resolver.js";
import { getPackageNameForFile, type RepoContext } from "./repo-context.js";
import { detectTestFile } from "./test-detection.js";

/**
 * Phase 04 prompt 4, sub-task 4.3: the two-pass graph builder — pass 1 parses every
 * eligible file and persists its symbols; pass 2 resolves imports, calls, and heritage
 * across the *whole* file set (now that every symbol has a real id) and persists the
 * resulting `CodeDependency` edges. Knows nothing about Inngest — same seam discipline as
 * `indexer.service.ts` (no `step.run`, no retries): this module is directly callable from
 * a test with no Inngest runtime, and `indexer.service.ts` is the only thing that wraps it
 * in the extraction callback whose temp directory `rootDir` requires being live for.
 *
 * Idempotency is full replacement, scoped to the repository (prompt-1 §2.5): every
 * existing `CodeDependency` row for `repositoryId` is deleted, then every existing
 * `CodeSymbol` row, before this run inserts a single fresh row — **edges before symbols**,
 * because `CodeDependency` has no foreign key to `CodeSymbol` (a dangling `toSymbolId`
 * would otherwise sit on a still-live edge row between the two deletes).
 */

// ---------------------------------------------------------------------------
// Public input/output shapes
// ---------------------------------------------------------------------------

/** Documents the parser's own scope (`parser-pool.ts`'s `selectLanguage` return type is
 * already restricted to exactly these three) — named to match this prompt's own §4.3
 * text; eligibility is decided by calling `selectLanguage` directly rather than trusting
 * `RepositoryFile.language` (which collapses `.tsx` into `"typescript"`, a coarser
 * granularity that would still agree on *eligibility* but is the wrong source of truth
 * for *which grammar* to parse with). */
export const PARSEABLE_LANGUAGES: readonly ParserLanguage[] = ["typescript", "tsx", "javascript"];

export interface GraphBuilderFileInput {
  id: string;
  path: string;
  indexState: IndexState;
  /** Phase 03's path-based `isTest` — carried through unchanged for any file this pass
   * cannot upgrade (FAILED/NOT_PARSED have no trustworthy import list to check). */
  isTest: boolean;
}

export interface GraphBuilderProgress {
  phase: "parse" | "resolve";
  filesProcessed: number;
  filesTotal: number;
}

export interface GraphBuilderOptions {
  /** The extraction root — still live for the duration of this call (see this module's
   * header: the caller must invoke this from inside `archive-extractor.ts`'s own
   * `onExtracted` callback). */
  rootDir: string;
  files: readonly GraphBuilderFileInput[];
  repoContext: RepoContext;
  repositoryId: string;
  commitSha: string;
  /** Inngest's `attempt` — drives {@link batchSizeForAttempt}. */
  attempt: number;
  logger?: Logger;
  onProgress?: (update: GraphBuilderProgress) => Promise<void>;
}

export interface FileGraphMetadata {
  fileId: string;
  symbolCount: number;
  parseState: ParseState;
  packageName: string | null;
  isTest: boolean;
}

export interface GraphBuilderResult {
  symbolsCreated: number;
  edgesCreated: number;
  parseFailureCount: number;
  filesParsedOk: number;
  filesNotParsed: number;
  unresolvedImportRatio: number;
  edgeCountsByKind: InsertedCountsByKind;
  fileGraphMetadata: FileGraphMetadata[];
}

// ---------------------------------------------------------------------------
// Attempt-aware batch sizing (spec §4/§12, plan.md §27.7)
// ---------------------------------------------------------------------------

/**
 * 200 files/batch on the first attempt (spec §4's own number), halved on the first retry,
 * halved again on every attempt after that. There is no way to observe an OOM from inside
 * the process it kills — the only honest signal available here is "this run is a retry",
 * so smaller batches on a retry is the whole mechanism, stated plainly rather than
 * dressed up as OOM detection. See this prompt's own report for whether a true OOM was
 * ever reproduced under a memory-limited container.
 */
export function batchSizeForAttempt(attempt: number): number {
  if (attempt <= 0) return 200;
  if (attempt === 1) return 100;
  return 50;
}

// ---------------------------------------------------------------------------
// Per-file in-memory record — what survives past a batch (never source text or trees)
// ---------------------------------------------------------------------------

interface FileRecord {
  fileId: string;
  filePath: string;
  packageName: string | null;
  parseState: ParseState;
  parseErrorCount: number;
  /** Original parse order, empty for FAILED/NOT_PARSED — a FAILED file's own
   * error-tolerance was already exceeded (>10% ERROR/MISSING nodes), so nothing extracted
   * from it is trusted for the graph; the `RepositoryFile` row itself still survives
   * (spec §4: "the file stays text-indexed"), only its symbol/edge contribution is empty. */
  symbols: ParsedSymbol[];
  /** Parallel to `symbols` by array position — the same correlation
   * `call-resolver.ts`'s own `CallResolverFileInput` contract requires. */
  callResolverSymbols: CallResolverSymbol[];
  /** Last-declaration-wins name -> id lookup for this file alone — used to resolve a
   * method's `parentSymbol` (its enclosing class's name) to that class's own generated id,
   * and as heritage rule 1's same-file lookup. */
  nameToId: Map<string, string>;
  imports: ParsedImport[];
  importResolutions: Map<string, ImportResolution>;
  exports: ParsedExport[];
  isTest: boolean;
}

// ---------------------------------------------------------------------------
// Pass 1 — parse and persist symbols, batched
// ---------------------------------------------------------------------------

function emptyRecord(fileId: string, filePath: string, packageName: string | null, parseState: ParseState, isTest: boolean): FileRecord {
  return {
    fileId,
    filePath,
    packageName,
    parseState,
    parseErrorCount: 0,
    symbols: [],
    callResolverSymbols: [],
    nameToId: new Map(),
    imports: [],
    importResolutions: new Map(),
    exports: [],
    isTest,
  };
}

async function runPass1(
  options: GraphBuilderOptions,
  logger: Logger,
): Promise<{ records: Map<string, FileRecord>; parseFailureCount: number; symbolsCreated: number }> {
  const records = new Map<string, FileRecord>();
  const eligible: GraphBuilderFileInput[] = [];

  for (const file of options.files) {
    const language = selectLanguage(file.path);
    if (file.indexState !== "INDEXED" || language === null) {
      const packageName = getPackageNameForFile(options.repoContext, file.path);
      records.set(file.path, emptyRecord(file.id, file.path, packageName, "NOT_PARSED", file.isTest));
      continue;
    }
    eligible.push(file);
  }

  const batchSize = batchSizeForAttempt(options.attempt);
  let parseFailureCount = 0;
  let symbolsCreated = 0;
  let filesProcessed = 0;

  for (let offset = 0; offset < eligible.length; offset += batchSize) {
    const batch = eligible.slice(offset, offset + batchSize);
    const batchStart = Date.now();
    const symbolRows: CodeSymbolInsertInput[] = [];
    let batchFailures = 0;

    for (const file of batch) {
      const language = selectLanguage(file.path)!; // eligible[] already filtered non-null
      const packageName = getPackageNameForFile(options.repoContext, file.path);

      let content: string;
      try {
        content = await fs.readFile(path.join(options.rootDir, file.path), "utf8");
      } catch (error) {
        logger.warn("graph-builder: failed to read a file for parsing — marking it FAILED and continuing", {
          repositoryId: options.repositoryId,
          path: file.path,
          error: error instanceof Error ? error.message : String(error),
        });
        records.set(file.path, emptyRecord(file.id, file.path, packageName, "FAILED", file.isTest));
        parseFailureCount += 1;
        batchFailures += 1;
        continue;
      }

      const parsed = await parseOneFile(file.path, language, content, logger, options.repositoryId);

      if (parsed === null || isParseRefusal(parsed)) {
        // `null` never happens (parseFile only throws for a genuine bug, caught inside
        // parseOneFile); `isParseRefusal` covers CONTENT_TOO_LARGE, structurally
        // unreachable here since file-classifier's 512 KB size cap (the only way a file
        // reaches indexState=INDEXED) is well under the parser pool's 2 MiB guard —
        // handled anyway, defensively, rather than assumed away.
        records.set(file.path, emptyRecord(file.id, file.path, packageName, "FAILED", file.isTest));
        parseFailureCount += 1;
        batchFailures += 1;
        continue;
      }

      if (parsed.parseState === "FAILED") {
        parseFailureCount += 1;
        batchFailures += 1;
        records.set(
          file.path,
          { ...emptyRecord(file.id, file.path, packageName, "FAILED", file.isTest), parseErrorCount: parsed.parseErrors },
        );
        continue;
      }

      const ids = parsed.symbols.map(() => randomUUID());
      const nameToId = new Map<string, string>();
      parsed.symbols.forEach((sym, i) => nameToId.set(sym.name, ids[i]!));

      const callResolverSymbols: CallResolverSymbol[] = parsed.symbols.map((sym, i) => ({
        id: ids[i]!,
        name: sym.name,
        kind: sym.kind,
        parentSymbol: sym.parentSymbol,
      }));

      for (let i = 0; i < parsed.symbols.length; i += 1) {
        const sym = parsed.symbols[i]!;
        const parentSymbolId = sym.parentSymbol !== undefined ? (nameToId.get(sym.parentSymbol) ?? null) : null;
        symbolRows.push({
          id: ids[i]!,
          repositoryId: options.repositoryId,
          fileId: file.id,
          name: sym.name,
          kind: sym.kind,
          startLine: sym.startLine,
          endLine: sym.endLine,
          isExported: sym.isExported,
          isDefault: sym.isDefault,
          signature: sym.signature || null,
          docComment: sym.docComment ?? null,
          parentSymbolId,
          complexity: sym.complexity,
          commitSha: options.commitSha,
        });
      }

      const importResolutions = new Map<string, ImportResolution>();
      for (const imp of parsed.imports) {
        if (!importResolutions.has(imp.specifier)) {
          importResolutions.set(imp.specifier, resolveImport(imp.specifier, file.path, options.repoContext));
        }
      }

      const isTest = detectTestFile(file.path, { imports: parsed.imports }).isTest;

      records.set(file.path, {
        fileId: file.id,
        filePath: file.path,
        packageName,
        parseState: "OK",
        parseErrorCount: parsed.parseErrors,
        symbols: parsed.symbols,
        callResolverSymbols,
        nameToId,
        imports: parsed.imports,
        importResolutions,
        exports: parsed.exports,
        isTest,
      });
    }

    if (symbolRows.length > 0) {
      await insertCodeSymbols(symbolRows);
      symbolsCreated += symbolRows.length;
    }

    filesProcessed += batch.length;
    const durationMs = Date.now() - batchStart;
    logger.info("parse batch completed", {
      component: "indexing.parser",
      repositoryId: options.repositoryId,
      batchSize: batch.length,
      parseFailureCount: batchFailures,
      durationMs,
    });
    await options.onProgress?.({ phase: "parse", filesProcessed, filesTotal: eligible.length });
  }

  return { records, parseFailureCount, symbolsCreated };
}

/** Isolates `parseFile`'s one legitimate throw path (a genuine bug, per that module's own
 * doc comment) so a single file's unexpected exception cannot abort the whole batch —
 * spec §4/§15: "a single malformed file never fails the overall index job." */
async function parseOneFile(
  filePath: string,
  language: ParserLanguage,
  content: string,
  logger: Logger,
  repositoryId: string,
): Promise<Awaited<ReturnType<typeof parseFile>> | null> {
  try {
    return await parseFile(filePath, language, content);
  } catch (error) {
    logger.warn("graph-builder: parseFile threw unexpectedly — marking the file FAILED and continuing", {
      repositoryId,
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pass 2 — heritage (EXTENDS/IMPLEMENTS) resolution
// ---------------------------------------------------------------------------

interface HeritageIndexedSymbol {
  id: string;
  filePath: string;
  packageName: string | null;
}

/**
 * `plan.md` has no dedicated rule for EXTENDS/IMPLEMENTS resolution — only CALLS gets the
 * five-rule heuristic (§11.4). This reuses that same rule *structure* and its exact
 * confidence constants (same-file → named-import → unique-match → ambiguous-tiebreak →
 * skip), restricted to CLASS/INTERFACE-kind candidates, rather than inventing a fresh
 * scheme: heritage resolution is a strict subset of the same underlying problem (resolve a
 * bare name to a declaration, repo-wide), and reusing the constants keeps the confidence
 * scale meaningful across every edge kind Phase 08 ranks by.
 */
function buildHeritageIndex(records: ReadonlyMap<string, FileRecord>, perPackage: boolean): Map<string, Map<string, HeritageIndexedSymbol[]>> {
  const index = new Map<string, Map<string, HeritageIndexedSymbol[]>>();
  for (const record of records.values()) {
    const bucketKey = perPackage ? (record.packageName ?? "") : "";
    let byName = index.get(bucketKey);
    if (!byName) {
      byName = new Map();
      index.set(bucketKey, byName);
    }
    for (let i = 0; i < record.symbols.length; i += 1) {
      const sym = record.symbols[i]!;
      if (sym.kind !== "CLASS" && sym.kind !== "INTERFACE") continue;
      const indexed: HeritageIndexedSymbol = { id: record.callResolverSymbols[i]!.id, filePath: record.filePath, packageName: record.packageName };
      const list = byName.get(sym.name);
      if (list) list.push(indexed);
      else byName.set(sym.name, [indexed]);
    }
  }
  return index;
}

function topLevelSegment(filePath: string): string {
  const slash = filePath.indexOf("/");
  return slash === -1 ? filePath : filePath.slice(0, slash);
}

function narrowHeritageCandidates(candidates: readonly HeritageIndexedSymbol[], fromRecord: FileRecord): HeritageIndexedSymbol[] {
  if (fromRecord.packageName !== null) {
    const samePackage = candidates.filter((c) => c.packageName === fromRecord.packageName);
    if (samePackage.length > 0) return samePackage;
  }
  const topLevel = topLevelSegment(fromRecord.filePath);
  const sameTopLevel = candidates.filter((c) => topLevelSegment(c.filePath) === topLevel);
  if (sameTopLevel.length > 0) return sameTopLevel;
  return [...candidates];
}

interface HeritageMatch {
  id: string;
  confidence: number;
}

function resolveHeritageName(
  name: string,
  fromRecord: FileRecord,
  records: ReadonlyMap<string, FileRecord>,
  index: Map<string, Map<string, HeritageIndexedSymbol[]>>,
  perPackage: boolean,
): HeritageMatch[] {
  // Rule 1 — same file.
  const sameFileIdx = fromRecord.symbols.findIndex((s) => s.name === name && (s.kind === "CLASS" || s.kind === "INTERFACE"));
  if (sameFileIdx !== -1) {
    return [{ id: fromRecord.callResolverSymbols[sameFileIdx]!.id, confidence: CALL_CONFIDENCE_SAME_FILE }];
  }

  // Rule 2 — named import resolved to its target file's matching CLASS/INTERFACE export.
  const imp = fromRecord.imports.find((i) => !i.isTypeOnly && i.named.includes(name));
  if (imp) {
    const resolution = fromRecord.importResolutions.get(imp.specifier);
    if (resolution?.status === "RESOLVED") {
      const target = records.get(resolution.targetFilePath);
      if (target) {
        const idx = target.symbols.findIndex((s) => s.name === name && (s.kind === "CLASS" || s.kind === "INTERFACE"));
        if (idx !== -1) return [{ id: target.callResolverSymbols[idx]!.id, confidence: CALL_CONFIDENCE_NAMED_IMPORT }];
      }
    }
  }

  // Rules 3/4 — repo-wide (or per-package) name index.
  const bucketKey = perPackage ? (fromRecord.packageName ?? "") : "";
  const candidates = index.get(bucketKey)?.get(name) ?? [];
  if (candidates.length === 0) return [];
  if (candidates.length === 1) return [{ id: candidates[0]!.id, confidence: CALL_CONFIDENCE_UNIQUE_REPO_MATCH }];

  const narrowed = narrowHeritageCandidates(candidates, fromRecord);
  if (narrowed.length > CALL_AMBIGUITY_MAX_CANDIDATES) return [];
  const confidence = CALL_CONFIDENCE_AMBIGUOUS_BASE / narrowed.length;
  return narrowed.map((c) => ({ id: c.id, confidence }));
}

// ---------------------------------------------------------------------------
// Pass 2 — edge construction
// ---------------------------------------------------------------------------

function edgeRow(
  kind: DependencyKind,
  ctx: { repositoryId: string; commitSha: string },
  fields: Partial<Omit<CodeDependencyInsertInput, "id" | "repositoryId" | "kind" | "commitSha">>,
): CodeDependencyInsertInput {
  return {
    id: randomUUID(),
    repositoryId: ctx.repositoryId,
    kind,
    fromFileId: null,
    toFileId: null,
    fromSymbolId: null,
    toSymbolId: null,
    externalPackage: null,
    rawSpecifier: null,
    resolution: "RESOLVED",
    confidence: 1,
    commitSha: ctx.commitSha,
    ...fields,
  };
}

function buildImportEdge(
  fileId: string,
  resolution: ImportResolution,
  records: ReadonlyMap<string, FileRecord>,
  ctx: { repositoryId: string; commitSha: string },
): CodeDependencyInsertInput {
  if (resolution.status === "RESOLVED") {
    const target = records.get(resolution.targetFilePath);
    return edgeRow("IMPORTS", ctx, { fromFileId: fileId, toFileId: target?.fileId ?? null, resolution: "RESOLVED" });
  }
  if (resolution.status === "EXTERNAL") {
    return edgeRow("IMPORTS", ctx, { fromFileId: fileId, externalPackage: resolution.packageName, resolution: "EXTERNAL" });
  }
  return edgeRow("IMPORTS", ctx, { fromFileId: fileId, rawSpecifier: resolution.specifier, resolution: "UNRESOLVED" });
}

async function runPass2(
  records: Map<string, FileRecord>,
  options: GraphBuilderOptions,
  logger: Logger,
): Promise<{ edgesCreated: number; edgeCountsByKind: InsertedCountsByKind }> {
  const perPackage = options.repoContext.workspaceRoots.length > 0;
  const ctx = { repositoryId: options.repositoryId, commitSha: options.commitSha };

  const callFiles: CallResolverFileInput[] = [...records.values()].map((r) => ({
    filePath: r.filePath,
    packageName: r.packageName,
    symbols: r.callResolverSymbols,
    parsedFile: { symbols: r.symbols, imports: r.imports },
    importResolutions: r.importResolutions,
  }));
  const callResult = resolveCalls(callFiles, perPackage);

  const heritageIndex = buildHeritageIndex(records, perPackage);

  const edges: CodeDependencyInsertInput[] = [];

  for (const record of records.values()) {
    // CONTAINS — one per symbol (spec §4.3: the highest-volume edge, deliberately emitted
    // in full; see this prompt's own report for the write-time/table-size call).
    for (let i = 0; i < record.symbols.length; i += 1) {
      edges.push(edgeRow("CONTAINS", ctx, { fromFileId: record.fileId, toSymbolId: record.callResolverSymbols[i]!.id }));
    }

    // EXPORTS — the file's own public surface among its locally declared symbols. A
    // re-export (`export * from "./x"`, no local name) already folded into `imports` by
    // the adapter (parsed-file.types.ts's own `ParsedExport.name` contract) and never
    // reaches this loop; an export naming a symbol this file did not itself declare
    // (`export { x } from "./other"`) has no local id to point at and is correctly
    // skipped (§0's false-negative bias: no symbol, no edge, not a guess).
    for (const exp of record.exports) {
      if (exp.name.length === 0) continue;
      const symbolId = record.nameToId.get(exp.name);
      if (!symbolId) continue;
      edges.push(edgeRow("EXPORTS", ctx, { fromFileId: record.fileId, toSymbolId: symbolId }));
    }

    // IMPORTS — every resolved specifier, RESOLVED/EXTERNAL/UNRESOLVED all get a row
    // (plan.md §11.2 step 4: no *file* edge for an EXTERNAL import, not "no row at all").
    for (const resolution of record.importResolutions.values()) {
      edges.push(buildImportEdge(record.fileId, resolution, records, ctx));
    }

    // EXTENDS / IMPLEMENTS.
    for (let i = 0; i < record.symbols.length; i += 1) {
      const sym = record.symbols[i]!;
      const fromSymbolId = record.callResolverSymbols[i]!.id;
      for (const name of sym.extends ?? []) {
        for (const match of resolveHeritageName(name, record, records, heritageIndex, perPackage)) {
          edges.push(edgeRow("EXTENDS", ctx, { fromSymbolId, toSymbolId: match.id, confidence: match.confidence }));
        }
      }
      for (const name of sym.implements ?? []) {
        for (const match of resolveHeritageName(name, record, records, heritageIndex, perPackage)) {
          edges.push(edgeRow("IMPLEMENTS", ctx, { fromSymbolId, toSymbolId: match.id, confidence: match.confidence }));
        }
      }
    }
  }

  // CALLS — from the confidence-ranked resolver (prompt 3).
  for (const call of callResult.edges) {
    edges.push(edgeRow("CALLS", ctx, { fromSymbolId: call.fromSymbolId, toSymbolId: call.toSymbolId, confidence: call.confidence }));
  }

  // TESTS — a test file to every non-test file it resolves an import to (spec §4.3's own
  // table). Runs after every file's imports are resolved, so a test file that imports
  // another test file's shared fixtures is correctly excluded (`!target.isTest`).
  for (const record of records.values()) {
    if (!record.isTest) continue;
    for (const resolution of record.importResolutions.values()) {
      if (resolution.status !== "RESOLVED") continue;
      const target = records.get(resolution.targetFilePath);
      if (!target || target.isTest) continue;
      edges.push(edgeRow("TESTS", ctx, { fromFileId: record.fileId, toFileId: target.fileId }));
    }
  }

  logger.info("call resolution completed", {
    component: "indexing.graph-builder",
    repositoryId: options.repositoryId,
    callEdges: callResult.edges.length,
    skippedForAmbiguity: callResult.skippedForAmbiguity,
  });

  const edgeCountsByKind = await insertCodeDependencies(edges);
  return { edgesCreated: edges.length, edgeCountsByKind };
}

// ---------------------------------------------------------------------------
// The public entry point
// ---------------------------------------------------------------------------

/**
 * `REFERENCES` — declared in `@repo/shared`'s `DEPENDENCY_KINDS` and this table's own
 * edge list (spec §4.3: "type usage — weaker than CALLS") — is **never produced by this
 * module**. Prompt 2's tree-sitter queries capture imports, exports, symbols, calls, and
 * class/interface heritage only; there is no query pattern for a bare type-reference use
 * site (`let x: Foo`, a generic type argument, …), so `ParsedFile` carries no data this
 * module could build a `REFERENCES` edge from. This mirrors the already-documented
 * `new_expression`-capture gap in `call-resolver.ts`'s own header: a real, deliberate
 * scope gap, not an oversight, stated here rather than fabricated.
 */
export async function buildKnowledgeGraph(options: GraphBuilderOptions): Promise<GraphBuilderResult> {
  const logger = options.logger ?? createLogger("indexing.graph-builder");

  // Full-replace, edges before symbols (prompt-1 §2.5's ordering — CodeDependency has no
  // FK to CodeSymbol, so the reverse order would leave dangling toSymbolId values).
  await deleteCodeDependenciesByRepository(options.repositoryId);
  await deleteCodeSymbolsByRepository(options.repositoryId);

  const { records, parseFailureCount, symbolsCreated } = await runPass1(options, logger);
  const { edgesCreated, edgeCountsByKind } = await runPass2(records, options, logger);

  const importCounts = edgeCountsByKind.IMPORTS ?? {};
  const resolvedCount = importCounts.RESOLVED ?? 0;
  const externalCount = importCounts.EXTERNAL ?? 0;
  const unresolvedCount = importCounts.UNRESOLVED ?? 0;
  const importTotal = resolvedCount + externalCount + unresolvedCount;
  const unresolvedImportRatio = importTotal === 0 ? 0 : unresolvedCount / importTotal;

  logger.info("graph resolution completed", {
    component: "indexing.graph-builder",
    repositoryId: options.repositoryId,
    edgeCountsByKind,
    edgesCreated,
    symbolsCreated,
    parseFailureCount,
    unresolvedImportRatio: Number(unresolvedImportRatio.toFixed(3)),
  });

  // §20: "the single most useful early-warning metric for this phase" — same
  // greppable "repository health note" precedent walk-tree.ts already set for the
  // hard-ignore ratio; gated on a minimum sample size so a tiny fixture repository
  // (a handful of imports) cannot trip it on noise the way walk-tree.ts's own
  // `pathsConsidered > 100` guard exists for the identical reason.
  if (unresolvedImportRatio > 0.15 && importTotal > 20) {
    logger.warn("repository health note: a large share of this repository's imports could not be resolved", {
      repositoryId: options.repositoryId,
      unresolvedImportRatio: Number(unresolvedImportRatio.toFixed(3)),
      importTotal,
    });
  }

  const recordList = [...records.values()];
  return {
    symbolsCreated,
    edgesCreated,
    parseFailureCount,
    filesParsedOk: recordList.filter((r) => r.parseState === "OK").length,
    filesNotParsed: recordList.filter((r) => r.parseState === "NOT_PARSED").length,
    unresolvedImportRatio,
    edgeCountsByKind,
    fileGraphMetadata: recordList.map((r) => ({
      fileId: r.fileId,
      symbolCount: r.symbols.length,
      parseState: r.parseState,
      packageName: r.packageName,
      isTest: r.isTest,
    })),
  };
}

// Re-exported so callers building a `GraphBuilderFileInput[]` know the exact
// `SymbolKind` union without a second import from `@repo/shared` — avoids a redundant
// import at every call site for a type this module already needs itself.
export type { SymbolKind };
