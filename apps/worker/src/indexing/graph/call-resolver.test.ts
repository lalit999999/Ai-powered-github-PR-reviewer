import { describe, expect, it } from "vitest";
import {
  CALL_AMBIGUITY_MAX_CANDIDATES,
  CALL_CONFIDENCE_NAMED_IMPORT,
  CALL_CONFIDENCE_SAME_FILE,
  CALL_CONFIDENCE_UNIQUE_REPO_MATCH,
  resolveCalls,
  type CallResolverFileInput,
  type CallResolverSymbol,
} from "./call-resolver.js";
import type { ImportResolution } from "./import-resolver.js";
import type { ParsedCall, ParsedFile, ParsedImport, ParsedSymbol } from "../parsing/parsed-file.types.js";

// ---------------------------------------------------------------------------
// Fixture builders — realistic monorepo-shaped paths throughout (per §0's own
// instruction: "a.ts/b.ts never exercises the tie-breaking logic the way a real
// monorepo path does").
// ---------------------------------------------------------------------------

let nextId = 0;
function freshId(): string {
  nextId += 1;
  return `sym-${nextId.toString()}`;
}

function sym(name: string, kind: ParsedSymbol["kind"], opts: { calls?: ParsedCall[]; parentSymbol?: string } = {}): {
  id: string;
  parsedSymbol: ParsedSymbol;
} {
  return {
    id: freshId(),
    parsedSymbol: {
      name,
      kind,
      startLine: 1,
      endLine: 10,
      isExported: true,
      isDefault: false,
      signature: `${name}()`,
      complexity: 1,
      calls: opts.calls ?? [],
      parentSymbol: opts.parentSymbol,
    },
  };
}

function call(name: string, receiver?: string): ParsedCall {
  return { name, receiver, line: 5 };
}

function namedImport(specifier: string, named: string[]): ParsedImport {
  return { specifier, named, line: 1, isTypeOnly: false, syntax: "static" };
}

function namespaceImport(specifier: string, namespace: string): ParsedImport {
  return { specifier, named: [], namespace, line: 1, isTypeOnly: false, syntax: "static" };
}

interface FileSpec {
  filePath: string;
  packageName: string | null;
  entries: { id: string; parsedSymbol: ParsedSymbol }[];
  imports?: ParsedImport[];
  importResolutions?: Record<string, ImportResolution>;
}

function buildFile(spec: FileSpec): CallResolverFileInput {
  const symbols: CallResolverSymbol[] = spec.entries.map((e) => ({
    id: e.id,
    name: e.parsedSymbol.name,
    kind: e.parsedSymbol.kind,
    parentSymbol: e.parsedSymbol.parentSymbol,
  }));
  const parsedFile: Pick<ParsedFile, "symbols" | "imports"> = {
    symbols: spec.entries.map((e) => e.parsedSymbol),
    imports: spec.imports ?? [],
  };
  const importResolutions = new Map(Object.entries(spec.importResolutions ?? {}));
  return { filePath: spec.filePath, packageName: spec.packageName, symbols, parsedFile, importResolutions };
}

function edgesFor(result: ReturnType<typeof resolveCalls>, fromId: string) {
  return result.edges.filter((e) => e.fromSymbolId === fromId);
}

// ---------------------------------------------------------------------------
// Rule 1 — same file beats cross-file
// ---------------------------------------------------------------------------

describe("resolveCalls — rule 1: same-file", () => {
  it("resolves a call to a same-file definition over an identically-named symbol elsewhere in the repo", () => {
    const helperElsewhere = sym("format", "FUNCTION");
    const caller = sym("render", "FUNCTION", { calls: [call("format")] });
    const localFormat = sym("format", "FUNCTION");

    const otherFile = buildFile({ filePath: "packages/ui/src/format.ts", packageName: "@repo/ui", entries: [helperElsewhere] });
    const callerFile = buildFile({
      filePath: "apps/web/src/components/Card.tsx",
      packageName: "web",
      entries: [caller, localFormat],
    });

    const result = resolveCalls([otherFile, callerFile], false);
    const edges = edgesFor(result, caller.id);
    expect(edges).toEqual([{ fromSymbolId: caller.id, toSymbolId: localFormat.id, rule: "SAME_FILE", confidence: CALL_CONFIDENCE_SAME_FILE }]);
  });

  it("emits a self-recursion edge (documented decision: emit, not skip)", () => {
    const factorial = sym("factorial", "FUNCTION", { calls: [call("factorial")] });
    const file = buildFile({ filePath: "apps/web/src/lib/math.ts", packageName: "web", entries: [factorial] });

    const result = resolveCalls([file], false);
    expect(result.edges).toEqual([
      { fromSymbolId: factorial.id, toSymbolId: factorial.id, rule: "SAME_FILE", confidence: CALL_CONFIDENCE_SAME_FILE },
    ]);
  });

  it("resolves this.foo() to the enclosing class's own same-named method", () => {
    const other = sym("save", "METHOD", { parentSymbol: "OtherRepo" });
    const method = sym("update", "METHOD", { calls: [call("save", "this")], parentSymbol: "UserRepo" });
    const target = sym("save", "METHOD", { parentSymbol: "UserRepo" });

    const otherFile = buildFile({ filePath: "packages/db/src/other-repo.ts", packageName: "@repo/db", entries: [other] });
    const file = buildFile({ filePath: "apps/web/src/lib/user-repo.ts", packageName: "web", entries: [method, target] });

    const result = resolveCalls([otherFile, file], false);
    const edges = edgesFor(result, method.id);
    expect(edges).toEqual([{ fromSymbolId: method.id, toSymbolId: target.id, rule: "SAME_FILE", confidence: CALL_CONFIDENCE_SAME_FILE }]);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — named import beats a same-name coincidence elsewhere
// ---------------------------------------------------------------------------

describe("resolveCalls — rule 2: named import", () => {
  it("resolves a bare call via a named import, over an unrelated same-named symbol elsewhere", () => {
    const realTarget = sym("validate", "FUNCTION");
    const decoy = sym("validate", "FUNCTION"); // an unrelated same-named function in a third file
    const caller = sym("handleSubmit", "FUNCTION", { calls: [call("validate")] });

    const targetFile = buildFile({ filePath: "packages/shared/src/validate.ts", packageName: "@repo/shared", entries: [realTarget] });
    const decoyFile = buildFile({ filePath: "packages/other/src/validate.ts", packageName: "@repo/other", entries: [decoy] });
    const callerFile = buildFile({
      filePath: "apps/web/src/forms/submit.ts",
      packageName: "web",
      entries: [caller],
      imports: [namedImport("../../../../packages/shared/src/validate.js", ["validate"])],
      importResolutions: {
        "../../../../packages/shared/src/validate.js": { status: "RESOLVED", targetFilePath: "packages/shared/src/validate.ts" },
      },
    });

    const result = resolveCalls([targetFile, decoyFile, callerFile], false);
    const edges = edgesFor(result, caller.id);
    expect(edges).toEqual([
      { fromSymbolId: caller.id, toSymbolId: realTarget.id, rule: "NAMED_IMPORT", confidence: CALL_CONFIDENCE_NAMED_IMPORT },
    ]);
  });

  it("resolves a namespace-import member call to the target module's export", () => {
    const target = sym("parse", "FUNCTION");
    const caller = sym("run", "FUNCTION", { calls: [call("parse", "utils")] });

    const targetFile = buildFile({ filePath: "apps/web/src/lib/utils.ts", packageName: "web", entries: [target] });
    const callerFile = buildFile({
      filePath: "apps/web/src/app.ts",
      packageName: "web",
      entries: [caller],
      imports: [namespaceImport("./lib/utils.js", "utils")],
      importResolutions: { "./lib/utils.js": { status: "RESOLVED", targetFilePath: "apps/web/src/lib/utils.ts" } },
    });

    const result = resolveCalls([targetFile, callerFile], false);
    const edges = edgesFor(result, caller.id);
    expect(edges).toEqual([{ fromSymbolId: caller.id, toSymbolId: target.id, rule: "NAMED_IMPORT", confidence: CALL_CONFIDENCE_NAMED_IMPORT }]);
  });

  it("falls through to repo-wide matching when the named import target does not resolve", () => {
    const onlyMatch = sym("validate", "FUNCTION");
    const caller = sym("handleSubmit", "FUNCTION", { calls: [call("validate")] });

    const targetFile = buildFile({ filePath: "packages/shared/src/validate.ts", packageName: "@repo/shared", entries: [onlyMatch] });
    const callerFile = buildFile({
      filePath: "apps/web/src/forms/submit.ts",
      packageName: "web",
      entries: [caller],
      imports: [namedImport("nonexistent-pkg", ["validate"])],
      importResolutions: { "nonexistent-pkg": { status: "EXTERNAL", packageName: "nonexistent-pkg" } },
    });

    const result = resolveCalls([targetFile, callerFile], false);
    const edges = edgesFor(result, caller.id);
    expect(edges).toEqual([
      { fromSymbolId: caller.id, toSymbolId: onlyMatch.id, rule: "UNIQUE_REPO_MATCH", confidence: CALL_CONFIDENCE_UNIQUE_REPO_MATCH },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — exactly one repo-wide match
// ---------------------------------------------------------------------------

describe("resolveCalls — rule 3: unique repo-wide match", () => {
  it("resolves when exactly one exported symbol repo-wide matches the call name", () => {
    const target = sym("formatCurrency", "FUNCTION");
    const caller = sym("render", "FUNCTION", { calls: [call("formatCurrency")] });

    const targetFile = buildFile({ filePath: "packages/shared/src/money.ts", packageName: "@repo/shared", entries: [target] });
    const callerFile = buildFile({ filePath: "apps/web/src/components/Price.tsx", packageName: "web", entries: [caller] });

    const result = resolveCalls([targetFile, callerFile], false);
    const edges = edgesFor(result, caller.id);
    expect(edges).toEqual([
      { fromSymbolId: caller.id, toSymbolId: target.id, rule: "UNIQUE_REPO_MATCH", confidence: CALL_CONFIDENCE_UNIQUE_REPO_MATCH },
    ]);
  });

  it("excludes non-callable kinds from candidates entirely", () => {
    const iface = sym("Handler", "INTERFACE");
    const typeAlias = sym("Handler", "TYPE_ALIAS");
    const caller = sym("dispatch", "FUNCTION", { calls: [call("Handler")] });

    const declFile = buildFile({ filePath: "packages/shared/src/types.ts", packageName: "@repo/shared", entries: [iface, typeAlias] });
    const callerFile = buildFile({ filePath: "apps/web/src/dispatch.ts", packageName: "web", entries: [caller] });

    const result = resolveCalls([declFile, callerFile], false);
    expect(edgesFor(result, caller.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — ambiguity: two-level tie-break, spread, and the N>3 skip
// ---------------------------------------------------------------------------

describe("resolveCalls — rule 4: ambiguous matches", () => {
  it("narrows to the same-package candidate when the caller shares a package with exactly one match", () => {
    const samePackage = sym("handler", "FUNCTION");
    const otherPackage1 = sym("handler", "FUNCTION");
    const otherPackage2 = sym("handler", "FUNCTION");
    const caller = sym("route", "FUNCTION", { calls: [call("handler")] });

    const f1 = buildFile({ filePath: "apps/web/src/lib/handler.ts", packageName: "web", entries: [samePackage] });
    const f2 = buildFile({ filePath: "packages/ui/src/handler.ts", packageName: "@repo/ui", entries: [otherPackage1] });
    const f3 = buildFile({ filePath: "packages/db/src/handler.ts", packageName: "@repo/db", entries: [otherPackage2] });
    const callerFile = buildFile({ filePath: "apps/web/src/routes/index.ts", packageName: "web", entries: [caller] });

    const result = resolveCalls([f1, f2, f3, callerFile], false);
    const edges = edgesFor(result, caller.id);
    expect(edges).toEqual([{ fromSymbolId: caller.id, toSymbolId: samePackage.id, rule: "AMBIGUOUS_TIEBREAK", confidence: 0.4 }]);
  });

  it("falls back to same-top-level-directory when no candidate shares the caller's package", () => {
    const sameTopLevel = sym("handler", "FUNCTION");
    const otherTopLevel = sym("handler", "FUNCTION");
    const caller = sym("route", "FUNCTION", { calls: [call("handler")] });

    const f1 = buildFile({ filePath: "apps/admin/src/handler.ts", packageName: "admin", entries: [sameTopLevel] });
    const f2 = buildFile({ filePath: "packages/db/src/handler.ts", packageName: "@repo/db", entries: [otherTopLevel] });
    const callerFile = buildFile({ filePath: "apps/web/src/routes/index.ts", packageName: "web", entries: [caller] });

    const result = resolveCalls([f1, f2, callerFile], false);
    const edges = edgesFor(result, caller.id);
    expect(edges).toEqual([{ fromSymbolId: caller.id, toSymbolId: sameTopLevel.id, rule: "AMBIGUOUS_TIEBREAK", confidence: 0.4 }]);
  });

  it("spreads confidence 0.4/N across a narrowed ambiguous set with N in [2,3]", () => {
    const a = sym("handler", "FUNCTION");
    const b = sym("handler", "FUNCTION");
    const caller = sym("route", "FUNCTION", { calls: [call("handler")] });

    const f1 = buildFile({ filePath: "apps/web/src/a/handler.ts", packageName: "web", entries: [a] });
    const f2 = buildFile({ filePath: "apps/web/src/b/handler.ts", packageName: "web", entries: [b] });
    const callerFile = buildFile({ filePath: "apps/web/src/routes/index.ts", packageName: "web", entries: [caller] });

    const result = resolveCalls([f1, f2, callerFile], false);
    const edges = edgesFor(result, caller.id);
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.rule).toBe("AMBIGUOUS_TIEBREAK");
      expect(edge.confidence).toBeCloseTo(0.4 / 2, 10);
    }
  });

  it("skips entirely — zero edges — when the narrowed ambiguous set exceeds 3 candidates", () => {
    expect(CALL_AMBIGUITY_MAX_CANDIDATES).toBe(3);

    const decls = Array.from({ length: 10 }, () => sym("handler", "FUNCTION"));
    const files = decls.map((d, i) => buildFile({ filePath: `apps/web/src/mod${i.toString()}/handler.ts`, packageName: "web", entries: [d] }));
    const caller = sym("route", "FUNCTION", { calls: [call("handler")] });
    const callerFile = buildFile({ filePath: "apps/web/src/routes/index.ts", packageName: "web", entries: [caller] });

    const result = resolveCalls([...files, callerFile], false);
    expect(edgesFor(result, caller.id)).toEqual([]);
    expect(result.skippedForAmbiguity).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — method-call receiver-in-scope requirement
// ---------------------------------------------------------------------------

describe("resolveCalls — rule 5: method-call receiver-in-scope", () => {
  it("resolves obj.foo() only when the method's class is imported into the calling file", () => {
    const method = sym("save", "METHOD", { parentSymbol: "UserRepo" });
    const decoyMethod = sym("save", "METHOD", { parentSymbol: "OrderRepo" });
    const caller = sym("handler", "FUNCTION", { calls: [call("save", "repo")] });

    const classFile = buildFile({ filePath: "packages/db/src/user-repo.ts", packageName: "@repo/db", entries: [method] });
    const decoyFile = buildFile({ filePath: "packages/db/src/order-repo.ts", packageName: "@repo/db", entries: [decoyMethod] });
    const callerFile = buildFile({
      filePath: "apps/web/src/routes/user.ts",
      packageName: "web",
      entries: [caller],
      imports: [namedImport("../../../../packages/db/src/user-repo.js", ["UserRepo"])],
    });

    const result = resolveCalls([classFile, decoyFile, callerFile], false);
    const edges = edgesFor(result, caller.id);
    expect(edges).toEqual([
      { fromSymbolId: caller.id, toSymbolId: method.id, rule: "UNIQUE_REPO_MATCH", confidence: CALL_CONFIDENCE_UNIQUE_REPO_MATCH },
    ]);
  });

  it("does not resolve obj.foo() when neither candidate's class is imported into the calling file (falls to ambiguity, N<=3 spread)", () => {
    const method1 = sym("save", "METHOD", { parentSymbol: "UserRepo" });
    const method2 = sym("save", "METHOD", { parentSymbol: "OrderRepo" });
    const caller = sym("handler", "FUNCTION", { calls: [call("save", "repo")] });

    const classFile1 = buildFile({ filePath: "packages/db/src/user-repo.ts", packageName: "@repo/db", entries: [method1] });
    const classFile2 = buildFile({ filePath: "packages/db/src/order-repo.ts", packageName: "@repo/db", entries: [method2] });
    const callerFile = buildFile({ filePath: "apps/web/src/routes/user.ts", packageName: "web", entries: [caller] });

    const result = resolveCalls([classFile1, classFile2, callerFile], false);
    // Neither UserRepo nor OrderRepo is imported — both candidates fail the receiver
    // check, leaving zero candidates entirely (not an ambiguity spread, since there is
    // nothing left to spread across).
    expect(edgesFor(result, caller.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-package name index
// ---------------------------------------------------------------------------

describe("resolveCalls — per-package name index", () => {
  it("in per-package mode, a same-name symbol in an unrelated package is never a candidate at all", () => {
    const target = sym("handler", "FUNCTION");
    const unrelatedPackageDecoy = sym("handler", "FUNCTION");
    const caller = sym("route", "FUNCTION", { calls: [call("handler")] });

    const targetFile = buildFile({ filePath: "apps/web/src/lib/handler.ts", packageName: "web", entries: [target] });
    const decoyFile = buildFile({ filePath: "packages/ui/src/handler.ts", packageName: "@repo/ui", entries: [unrelatedPackageDecoy] });
    const callerFile = buildFile({ filePath: "apps/web/src/routes/index.ts", packageName: "web", entries: [caller] });

    const result = resolveCalls([targetFile, decoyFile, callerFile], true);
    const edges = edgesFor(result, caller.id);
    // Unique match WITHIN the caller's own package — 0.7, not an ambiguous spread across
    // packages the per-package index never even considers.
    expect(edges).toEqual([
      { fromSymbolId: caller.id, toSymbolId: target.id, rule: "UNIQUE_REPO_MATCH", confidence: CALL_CONFIDENCE_UNIQUE_REPO_MATCH },
    ]);
  });

  it("in global mode, the same fixture is ambiguous across both packages", () => {
    const target = sym("handler", "FUNCTION");
    const otherPackage = sym("handler", "FUNCTION");
    const caller = sym("route", "FUNCTION", { calls: [call("handler")] });

    const targetFile = buildFile({ filePath: "apps/web/src/lib/handler.ts", packageName: "web", entries: [target] });
    const decoyFile = buildFile({ filePath: "packages/ui/src/handler.ts", packageName: "@repo/ui", entries: [otherPackage] });
    const callerFile = buildFile({ filePath: "apps/web/src/routes/index.ts", packageName: "web", entries: [caller] });

    const result = resolveCalls([targetFile, decoyFile, callerFile], false);
    const edges = edgesFor(result, caller.id);
    expect(edges).toEqual([{ fromSymbolId: caller.id, toSymbolId: target.id, rule: "AMBIGUOUS_TIEBREAK", confidence: 0.4 }]);
  });
});

// ---------------------------------------------------------------------------
// Pathological input bounds (sub-task 3.5 — the whole resolution path must stay linear
// against attacker-controllable repository content, §0 rule 4)
// ---------------------------------------------------------------------------

describe("resolveCalls — pathological input bounds", () => {
  it("completes quickly for a call site whose name is 50,000 repeated characters", () => {
    const hugeName = "a".repeat(50_000);
    const caller = sym("run", "FUNCTION", { calls: [call(hugeName)] });
    const callerFile = buildFile({ filePath: "apps/web/src/app.ts", packageName: "web", entries: [caller] });

    const start = Date.now();
    const result = resolveCalls([callerFile], false);
    const elapsedMs = Date.now() - start;
    console.log(`resolveCalls with a 50,000-char call name completed in ${elapsedMs.toString()}ms`);
    expect(elapsedMs).toBeLessThan(200);
    expect(edgesFor(result, caller.id)).toEqual([]);
  });
});
