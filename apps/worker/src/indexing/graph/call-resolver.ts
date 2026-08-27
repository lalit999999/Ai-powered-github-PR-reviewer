import type { SymbolKind } from "@repo/shared";
import type { ImportResolution } from "./import-resolver.js";
import type { ParsedFile, ParsedSymbol } from "../parsing/parsed-file.types.js";

/**
 * Prompt 3, sub-task 3.4: `plan.md` §11.4's five-rule, confidence-ranked call-resolution
 * heuristic. **This module determines the phase's headline precision metric** (≥70% on
 * 100 hand-labeled edges, measured in prompt 5) — every branch below states its
 * reasoning, because a later reader "simplifying" this file is the single most likely way
 * that number regresses.
 *
 * Pure — no Prisma, no filesystem. Symbol identity is caller-supplied
 * ({@link CallResolverSymbol.id}) rather than a real `CodeSymbol.id`, since those do not
 * exist until prompt 4 persists pass-1 output; this module never inspects the id's shape,
 * only carries it through onto the produced edges.
 *
 * ## What "the receiver's class is imported" can and cannot check
 *
 * `plan.md` §11.4 rule 5 asks whether the receiver's class is "imported or instantiated"
 * in the calling file. Prompt 2's tree-sitter queries capture `call_expression` only —
 * there is no `new_expression` pattern (verified directly against `queries.ts`), so a
 * `new Foo()` constructor call is never a {@link ParsedCall} at all and "instantiated" has
 * no observable signal this module can check. Only "imported" is checkable, via
 * {@link ParsedFile.imports}' local bindings. This is a real, documented gap: a class
 * instantiated through a local variable/factory with no direct import of the class name
 * in the calling file will not satisfy rule 5's receiver check and falls through to rule
 * 4's ambiguity handling — the safe direction (a missed edge, not a wrong one), but worth
 * stating plainly since it under-covers exactly the "instantiated" half of the rule's own
 * name.
 */

// ---------------------------------------------------------------------------
// Confidence constants — the contract with Phase 08 (`plan.md` §11.5 orders by these)
// ---------------------------------------------------------------------------

export const CALL_CONFIDENCE_SAME_FILE = 0.95;
export const CALL_CONFIDENCE_NAMED_IMPORT = 0.9;
export const CALL_CONFIDENCE_UNIQUE_REPO_MATCH = 0.7;
/** Divided by the final ambiguous-candidate-set size (`plan.md` §11.4 rule 4: `0.4/N`). */
export const CALL_CONFIDENCE_AMBIGUOUS_BASE = 0.4;
/** `N > CALL_AMBIGUITY_MAX_CANDIDATES` → skip entirely, never guess (§0 rule 3). */
export const CALL_AMBIGUITY_MAX_CANDIDATES = 3;

// ---------------------------------------------------------------------------
// Callable-kind filtering — a cheap, real precision win (§0's own framing)
// ---------------------------------------------------------------------------

/** A call must never resolve to a non-callable declaration. `CLASS` is deliberately
 * excluded too: with no `new_expression` capture (see this module's header), a
 * `call.name` matching a class name is almost always either noise or a shadowing bare
 * function with the same name — resolving it would be a guess, not a signal. */
const CALLABLE_KINDS = new Set<SymbolKind>([
  "FUNCTION",
  "ARROW_FUNCTION",
  "METHOD",
  "HOOK",
  "REACT_COMPONENT",
]);

/** Kinds eligible for a receiver-less (`foo()`) call — excludes `METHOD`, which requires
 * qualification (`obj.foo()` or `this.foo()`) to ever be reached by a bare call in valid
 * JS/TS. */
const BARE_CALL_KINDS = new Set<SymbolKind>([
  "FUNCTION",
  "ARROW_FUNCTION",
  "HOOK",
  "REACT_COMPONENT",
]);

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

export interface CallResolverSymbol {
  /** Opaque to this module — prompt 4 passes the real `CodeSymbol.id` once persisted;
   * tests pass any stable string. */
  id: string;
  name: string;
  kind: SymbolKind;
  /** The class name a `METHOD` belongs to (`ParsedSymbol.parentSymbol`), `undefined` for
   * every other kind. */
  parentSymbol?: string;
}

export interface CallResolverFileInput {
  filePath: string;
  /** The upgraded package name (`repo-context.ts`'s `getPackageNameForFile`), or `null`
   * for a file outside any detected package — used by rule 4's two-level tie-break and
   * by the per-package name-index partitioning. */
  packageName: string | null;
  /** This file's own top-level symbols, each carrying the caller-assigned id that
   * correlates 1:1 with `parsedFile.symbols` by array position. */
  symbols: CallResolverSymbol[];
  parsedFile: Pick<ParsedFile, "symbols" | "imports">;
  /** This file's own import resolutions, keyed by raw specifier — prompt 4 runs
   * `resolveImport` once per `ParsedImport` and passes the results back in, rather than
   * this module re-resolving them (§0's own instruction: "pass in the resolved imports
   * rather than re-resolving"). */
  importResolutions: ReadonlyMap<string, ImportResolution>;
}

export type CallResolutionRule =
  "SAME_FILE" | "NAMED_IMPORT" | "UNIQUE_REPO_MATCH" | "AMBIGUOUS_TIEBREAK";

export interface ResolvedCallEdge {
  fromSymbolId: string;
  toSymbolId: string;
  rule: CallResolutionRule;
  confidence: number;
}

export interface CallResolutionResult {
  edges: ResolvedCallEdge[];
  /** Count of call sites skipped outright by rule 4's `N > 3` ambiguity guard — exposed
   * so prompt 5's precision measurement (and §22's own required verification, "verify it
   * actually engages") has a direct number to check rather than inferring it from an
   * edge count that could be low for other reasons too. */
  skippedForAmbiguity: number;
}

// ---------------------------------------------------------------------------
// Name index — global or per-package (`plan.md` §11.3, spec §4)
// ---------------------------------------------------------------------------

interface IndexedSymbol extends CallResolverSymbol {
  filePath: string;
  packageName: string | null;
}

/**
 * Built once per {@link resolveCalls} call, partitioned by `packageName` when the
 * repository has any workspace roots at all (the caller decides this — see
 * {@link resolveCalls}'s own `perPackage` parameter), global otherwise. **This is a
 * feature, not just a memory bound**: a same-named symbol in an unrelated workspace
 * package stops being a rule-3/rule-4 candidate at all when partitioned, which is exactly
 * the "duplicate method names across classes" failure mode `plan.md` §10.5 names as the
 * reason call-edge precision lags import-edge precision — partitioning by package
 * directly improves it. Files with no detected package (`packageName === null`) share one
 * bucket (`""`) — they can only resolve calls among themselves in per-package mode, a
 * documented, deliberate narrowing of recall (never of precision) for repositories with a
 * genuinely undetectable package boundary.
 */
function buildNameIndex(
  files: readonly CallResolverFileInput[],
  perPackage: boolean,
): Map<string, Map<string, IndexedSymbol[]>> {
  const index = new Map<string, Map<string, IndexedSymbol[]>>();

  for (const file of files) {
    const bucketKey = perPackage ? (file.packageName ?? "") : "";
    let byName = index.get(bucketKey);
    if (!byName) {
      byName = new Map();
      index.set(bucketKey, byName);
    }
    for (const symbol of file.symbols) {
      if (!CALLABLE_KINDS.has(symbol.kind)) continue;
      const indexed: IndexedSymbol = {
        ...symbol,
        filePath: file.filePath,
        packageName: file.packageName,
      };
      const existing = byName.get(symbol.name);
      if (existing) existing.push(indexed);
      else byName.set(symbol.name, [indexed]);
    }
  }

  return index;
}

function candidatesForName(
  index: Map<string, Map<string, IndexedSymbol[]>>,
  bucketKey: string,
  name: string,
): IndexedSymbol[] {
  return index.get(bucketKey)?.get(name) ?? [];
}

// ---------------------------------------------------------------------------
// Rule 1 — same file
// ---------------------------------------------------------------------------

function resolveSameFile(
  callName: string,
  receiver: string | undefined,
  callerClassName: string | undefined,
  fileSymbols: readonly CallResolverSymbol[],
): CallResolverSymbol | null {
  if (receiver === undefined) {
    const match = fileSymbols.find(
      (s) => s.name === callName && BARE_CALL_KINDS.has(s.kind),
    );
    return match ?? null;
  }

  if (receiver === "this" && callerClassName !== undefined) {
    const match = fileSymbols.find(
      (s) =>
        s.name === callName &&
        s.kind === "METHOD" &&
        s.parentSymbol === callerClassName,
    );
    if (match) return match;
  }

  // A qualified call whose receiver is some other local identifier: still allow a
  // same-file method match by name alone — a same-file coincidence is already the
  // highest-confidence rule, and requiring exact receiver-to-class proof here would just
  // duplicate rule 5's own (already-conservative) check one rule too early.
  const methodMatch = fileSymbols.find(
    (s) => s.name === callName && s.kind === "METHOD",
  );
  return methodMatch ?? null;
}

// ---------------------------------------------------------------------------
// Rule 2 — named import (including a namespace-import member call)
// ---------------------------------------------------------------------------

/**
 * A namespace-import member call (`ns.foo()` where `ns` is bound by `import * as ns from
 * "./m"`) is folded into this same rule, at the same 0.9 confidence — `plan.md` §11.4
 * names it "a named import resolved to its target file's export"; a namespace import's
 * member access is the identical shape (a name resolved through a known, resolved import
 * to a specific target file's export) with no separate confidence tier invented for it
 * (§0's own instruction: "do not invent a sixth rule with a made-up confidence").
 */
function resolveNamedImport(
  callName: string,
  receiver: string | undefined,
  file: CallResolverFileInput,
  filesByPath: ReadonlyMap<string, CallResolverFileInput>,
): CallResolverSymbol | null {
  const imports = file.parsedFile.imports;

  if (receiver === undefined) {
    const imp = imports.find(
      (i) => !i.isTypeOnly && i.named.includes(callName),
    );
    if (!imp) return null;
    const resolution = file.importResolutions.get(imp.specifier);
    if (!resolution || resolution.status !== "RESOLVED") return null;
    const targetFile = filesByPath.get(resolution.targetFilePath);
    if (!targetFile) return null;
    return (
      targetFile.symbols.find(
        (s) => s.name === callName && CALLABLE_KINDS.has(s.kind),
      ) ?? null
    );
  }

  const namespaceImp = imports.find(
    (i) => !i.isTypeOnly && i.namespace === receiver,
  );
  if (!namespaceImp) return null;
  const resolution = file.importResolutions.get(namespaceImp.specifier);
  if (!resolution || resolution.status !== "RESOLVED") return null;
  const targetFile = filesByPath.get(resolution.targetFilePath);
  if (!targetFile) return null;
  return (
    targetFile.symbols.find(
      (s) => s.name === callName && CALLABLE_KINDS.has(s.kind),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Rule 5 — method-call receiver-in-scope requirement
// ---------------------------------------------------------------------------

/**
 * True only when `candidate`'s owning class name is textually bound in `file` by a
 * static import — see this module's header for why "instantiated" cannot be checked
 * separately. Deliberately does **not** try to match the receiver's own identifier text
 * against the imported local name: the overwhelmingly common shape is
 * `import { Foo } from "./foo"; const f = new Foo(); f.method()`, where the receiver
 * (`f`) is an instance variable, not the class name (`Foo`) itself — requiring identifier
 * equality would reject almost every real instance-method call and leave only the rare
 * static-call shape (`Foo.method()`) passing, defeating the point of the check. "Is the
 * class imported into this file at all" is the actual, checkable proxy for "in scope"
 * `plan.md` §11.4 rule 5 asks for. `receiver === "this"` always satisfies this (the
 * enclosing class is inherently in scope) but is handled by rule 1 before this function
 * is ever reached in practice; kept here too for defensiveness if rule 1 did not already
 * resolve it (e.g. a `this.foo()` call to a method not itself declared in `F`, which is
 * not valid TS but this module never assumes the input is type-checked).
 */
function isReceiverClassInScope(
  receiver: string,
  candidate: IndexedSymbol,
  file: CallResolverFileInput,
): boolean {
  if (receiver === "this") return true;
  const className = candidate.parentSymbol;
  if (!className) return false;
  return file.parsedFile.imports.some(
    (imp) =>
      !imp.isTypeOnly &&
      (imp.default === className || imp.named.includes(className)),
  );
}

// ---------------------------------------------------------------------------
// Rules 3/4 — repo-wide match, ambiguity tie-break and spread
// ---------------------------------------------------------------------------

function topLevelSegment(filePath: string): string {
  const slash = filePath.indexOf("/");
  return slash === -1 ? filePath : filePath.slice(0, slash);
}

/**
 * `plan.md` §11.4 rule 4, read literally: narrow the candidate set to same-package
 * members first; if that narrows to nothing, try same-top-level-directory instead; then
 * apply the `0.4/N` spread (or the `N > 3` skip) to whatever set survives narrowing —
 * including the case where narrowing already reduced it to exactly one (which still gets
 * `0.4/1 = 0.4`, deliberately below rule 3's `0.7`, since it started genuinely ambiguous
 * rather than unique repo-wide). If neither narrowing step finds anything at all (the
 * caller has no package and no candidate shares its top-level directory), the full
 * original candidate set is used — narrowing that would otherwise discard every option is
 * not applied.
 */
function narrowAmbiguousCandidates(
  candidates: readonly IndexedSymbol[],
  callerFile: CallResolverFileInput,
): IndexedSymbol[] {
  if (callerFile.packageName !== null) {
    const samePackage = candidates.filter(
      (c) => c.packageName === callerFile.packageName,
    );
    if (samePackage.length > 0) return samePackage;
  }

  const callerTopLevel = topLevelSegment(callerFile.filePath);
  const sameTopLevelDir = candidates.filter(
    (c) => topLevelSegment(c.filePath) === callerTopLevel,
  );
  if (sameTopLevelDir.length > 0) return sameTopLevelDir;

  return [...candidates];
}

// ---------------------------------------------------------------------------
// Per-call-site resolution
// ---------------------------------------------------------------------------

interface CallSiteContext {
  file: CallResolverFileInput;
  callerSymbolId: string;
  callerClassName: string | undefined;
  callName: string;
  receiver: string | undefined;
}

function resolveCallSite(
  ctx: CallSiteContext,
  filesByPath: ReadonlyMap<string, CallResolverFileInput>,
  index: Map<string, Map<string, IndexedSymbol[]>>,
  perPackage: boolean,
): {
  edge: ResolvedCallEdge | null;
  edges?: ResolvedCallEdge[];
  ambiguitySkipped: boolean;
} {
  const { file, callerSymbolId, callerClassName, callName, receiver } = ctx;

  // Rule 1 — same file.
  const sameFile = resolveSameFile(
    callName,
    receiver,
    callerClassName,
    file.symbols,
  );
  if (sameFile) {
    return {
      edge: {
        fromSymbolId: callerSymbolId,
        toSymbolId: sameFile.id,
        rule: "SAME_FILE",
        confidence: CALL_CONFIDENCE_SAME_FILE,
      },
      ambiguitySkipped: false,
    };
  }

  // Rule 2 — named import (bare call) or namespace-import member call.
  const namedImport = resolveNamedImport(callName, receiver, file, filesByPath);
  if (namedImport) {
    return {
      edge: {
        fromSymbolId: callerSymbolId,
        toSymbolId: namedImport.id,
        rule: "NAMED_IMPORT",
        confidence: CALL_CONFIDENCE_NAMED_IMPORT,
      },
      ambiguitySkipped: false,
    };
  }

  // Rules 3/4/5 — repo-wide (or per-package) name index.
  const bucketKey = perPackage ? (file.packageName ?? "") : "";
  let candidates = candidatesForName(index, bucketKey, callName);

  if (receiver !== undefined) {
    candidates = candidates.filter((c) => c.kind === "METHOD");
    // Rule 5: require the receiver's class to be in scope. A candidate that fails this
    // check is not a valid target at all for THIS call site — filtered out before
    // uniqueness/ambiguity is even evaluated, exactly as §0's framing describes ("else
    // treat as step 4" applies to the *remaining* ambiguity among candidates that do pass
    // the receiver check, not to candidates that fail it outright).
    candidates = candidates.filter((c) =>
      isReceiverClassInScope(receiver, c, file),
    );
  } else {
    candidates = candidates.filter((c) => BARE_CALL_KINDS.has(c.kind));
  }

  if (candidates.length === 0) return { edge: null, ambiguitySkipped: false };

  if (candidates.length === 1) {
    const only = candidates[0]!;
    return {
      edge: {
        fromSymbolId: callerSymbolId,
        toSymbolId: only.id,
        rule: "UNIQUE_REPO_MATCH",
        confidence: CALL_CONFIDENCE_UNIQUE_REPO_MATCH,
      },
      ambiguitySkipped: false,
    };
  }

  const narrowed = narrowAmbiguousCandidates(candidates, file);
  if (narrowed.length > CALL_AMBIGUITY_MAX_CANDIDATES) {
    return { edge: null, ambiguitySkipped: true };
  }

  const confidence = CALL_CONFIDENCE_AMBIGUOUS_BASE / narrowed.length;
  const edges = narrowed.map((c) => ({
    fromSymbolId: callerSymbolId,
    toSymbolId: c.id,
    rule: "AMBIGUOUS_TIEBREAK" as const,
    confidence,
  }));
  return { edge: null, edges, ambiguitySkipped: false };
}

// ---------------------------------------------------------------------------
// The public entry point
// ---------------------------------------------------------------------------

/**
 * Resolves every call site across `files` and returns the resulting edges. `files` is the
 * *whole* repository's parsed-and-import-resolved file set (or the whole package's, if
 * the caller has already partitioned by package for memory reasons at a higher level —
 * this function itself only partitions the *name index*, per `perPackage`, not its own
 * input). Deterministic order is not guaranteed beyond "one call site's candidates are
 * processed together" — callers needing a stable edge order should sort the result.
 *
 * `perPackage` is the caller's own decision (spec §4: "built per-package for monorepos
 * to bound memory further... globally otherwise") — pass `context.workspaceRoots.length >
 * 0` from the same {@link RepoContext} the import-resolver used, so both resolvers agree
 * on whether this repository is a monorepo.
 */
export function resolveCalls(
  files: readonly CallResolverFileInput[],
  perPackage: boolean,
): CallResolutionResult {
  const filesByPath = new Map(files.map((f) => [f.filePath, f]));
  const index = buildNameIndex(files, perPackage);

  const edges: ResolvedCallEdge[] = [];
  let skippedForAmbiguity = 0;

  for (const file of files) {
    for (let i = 0; i < file.parsedFile.symbols.length; i += 1) {
      const parsedSymbol: ParsedSymbol = file.parsedFile.symbols[i]!;
      const callerSymbol = file.symbols[i];
      if (!callerSymbol) continue; // caller/parsedFile arrays must correlate 1:1 by position

      const callerClassName =
        parsedSymbol.kind === "METHOD" ? parsedSymbol.parentSymbol : undefined;

      for (const call of parsedSymbol.calls) {
        const result = resolveCallSite(
          {
            file,
            callerSymbolId: callerSymbol.id,
            callerClassName,
            callName: call.name,
            receiver: call.receiver,
          },
          filesByPath,
          index,
          perPackage,
        );
        if (result.edge) edges.push(result.edge);
        if (result.edges) edges.push(...result.edges);
        if (result.ambiguitySkipped) skippedForAmbiguity += 1;
      }
    }
  }

  return { edges, skippedForAmbiguity };
}
