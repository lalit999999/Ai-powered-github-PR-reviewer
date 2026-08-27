import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@repo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDatabase } from "./db-helpers.js";
import { indexGraphRepoFixture } from "./graph-repo-fixture-helpers.js";

/**
 * Prompt 5, sub-task 5.2 — the phase's headline metric.
 *
 * **Precision, defined explicitly** (so nobody quietly changes the definition to make the
 * number look better):
 *
 *   precision = (correct positive resolutions + correct abstentions) / 100
 *
 *   correct positive  : the resolver produced an edge to exactly the expected target
 *   correct abstention: expected is null AND the resolver produced no edge to any
 *                        same-named candidate
 *   incorrect         : wrong target, an edge where null was expected, or no edge where
 *                        a target was expected
 *
 * A small number of labels carry `expectedAmbiguousSet` instead of a single `expected`
 * target — genuine N=2/N=3 ambiguity where the *correct* behavior (`plan.md` §11.4 rule 4)
 * is an edge to every plausible candidate, not silence. These score correct only when the
 * resolver produces an edge to every member of the set and no edge to any other
 * same-named candidate — see `graph-repo-labels.json`'s own `methodology` field.
 *
 * Labels were written by reading `tests/fixtures/graph-repo/` source directly and judging
 * each call site's correct resolution independently, **then** compared against what the
 * real pipeline produced — never the reverse (a label set written by reading the
 * resolver's own output first would measure nothing). Two labels are deliberately
 * expected misses, discovered *while* labeling, not fabricated to pad the "honest miss"
 * count: `apps/web/src/main.ts`'s `login()` call (the single-hop re-export/barrel
 * limitation) and `packages/core/src/http/router.ts`'s `webhookHandler()` call (an
 * aliased-import name mismatch — a newly-discovered gap, see this file's own report and
 * `docs/parsing.md`).
 */

interface ExpectedTarget {
  toFile: string;
  toSymbol: string;
}

interface LabelEntry {
  fromFile: string;
  fromSymbol: string;
  callName: string;
  callLine: number;
  expected: ExpectedTarget | null;
  expectedAmbiguousSet?: ExpectedTarget[];
  note: string;
}

interface LabelFile {
  labeledAt: string;
  labeledBy: string;
  methodology: string;
  edges: LabelEntry[];
}

const LABELS_PATH = path.resolve(fileURLToPath(new URL("../fixtures/graph-repo-labels.json", import.meta.url)));

/** Confidence -> the rule name/band the number § 11.4 assigns it to. Ambiguous-tiebreak
 * confidences are `0.4/N` for whatever N the call site narrowed to, so they are matched by
 * range rather than an exact constant. */
function bandFor(confidence: number): string {
  if (confidence >= 0.95) return "0.95 (SAME_FILE)";
  if (confidence >= 0.9) return "0.90 (NAMED_IMPORT)";
  if (confidence >= 0.7) return "0.70 (UNIQUE_REPO_MATCH)";
  return "<0.50 (AMBIGUOUS_TIEBREAK)";
}

interface Judgement {
  label: LabelEntry;
  correct: boolean;
  band: string;
  actual: string;
}

describe("call-edge precision — 100 hand-labeled edges in the fixture repo (phase-04 §14, headline metric)", () => {
  let labelFile: LabelFile;

  beforeAll(async () => {
    labelFile = JSON.parse(await readFile(LABELS_PATH, "utf8")) as LabelFile;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("has exactly 100 labeled edges, sampled across all five rules and including expected:null cases", () => {
    expect(labelFile.edges).toHaveLength(100);
    const withTarget = labelFile.edges.filter((e) => e.expected !== null).length;
    const withAmbiguousSet = labelFile.edges.filter((e) => e.expectedAmbiguousSet).length;
    const nullAbstentions = labelFile.edges.filter((e) => e.expected === null && !e.expectedAmbiguousSet).length;
    expect(withTarget).toBeGreaterThan(0);
    expect(withAmbiguousSet).toBeGreaterThan(0);
    // A meaningful share of correct-abstention cases (§0's own instruction: "a label set
    // drawn only from easy same-file calls measures nothing").
    expect(nullAbstentions).toBeGreaterThanOrEqual(20);
  });

  it("achieves at least 70% precision against the 100 hand labels, and prints the full breakdown", async () => {
    await resetDatabase();
    const { repository } = await indexGraphRepoFixture();

    const symbols = await prisma.codeSymbol.findMany({
      where: { repositoryId: repository.id },
      select: { id: true, name: true, fileId: true },
    });
    const files = await prisma.repositoryFile.findMany({
      where: { repositoryId: repository.id },
      select: { id: true, path: true },
    });
    const pathById = new Map(files.map((f) => [f.id, f.path]));
    const symbolsByFileAndName = new Map<string, { id: string }[]>();
    for (const s of symbols) {
      const key = `${pathById.get(s.fileId)}::${s.name}`;
      const list = symbolsByFileAndName.get(key) ?? [];
      list.push({ id: s.id });
      symbolsByFileAndName.set(key, list);
    }

    const callsEdges = await prisma.codeDependency.findMany({
      where: { repositoryId: repository.id, kind: "CALLS" },
      select: { fromSymbolId: true, toSymbolId: true, confidence: true },
    });
    const symbolMeta = new Map(symbols.map((s) => [s.id, { name: s.name, file: pathById.get(s.fileId) }]));

    // fromSymbolId -> [{ toName, toFile, confidence }]
    const outEdgesByFromSymbol = new Map<string, { toName: string; toFile: string | undefined; confidence: number }[]>();
    for (const edge of callsEdges) {
      if (!edge.fromSymbolId || !edge.toSymbolId) continue;
      const to = symbolMeta.get(edge.toSymbolId);
      if (!to) continue;
      const list = outEdgesByFromSymbol.get(edge.fromSymbolId) ?? [];
      list.push({ toName: to.name, toFile: to.file, confidence: edge.confidence });
      outEdgesByFromSymbol.set(edge.fromSymbolId, list);
    }

    function resolveFromSymbolId(label: LabelEntry): string | undefined {
      const candidates = symbolsByFileAndName.get(`${label.fromFile}::${label.fromSymbol}`);
      return candidates?.[0]?.id;
    }

    const judgements: Judgement[] = [];
    const mismatches: string[] = [];

    for (const label of labelFile.edges) {
      const fromSymbolId = resolveFromSymbolId(label);
      const outEdges = fromSymbolId ? (outEdgesByFromSymbol.get(fromSymbolId) ?? []) : [];
      // Every edge this fromSymbol produced whose target is named exactly like this call
      // site's callee — the set a single call site's resolution could possibly show up in.
      const edgesForThisCallName = outEdges.filter((e) => e.toName === label.callName);

      if (label.expectedAmbiguousSet) {
        const expectedKeys = new Set(label.expectedAmbiguousSet.map((t) => `${t.toFile}::${t.toSymbol}`));
        const actualKeys = new Set(edgesForThisCallName.map((e) => `${e.toFile}::${e.toName}`));
        const correct = expectedKeys.size === actualKeys.size && [...expectedKeys].every((k) => actualKeys.has(k));
        const band = edgesForThisCallName.length > 0 ? bandFor(edgesForThisCallName[0]!.confidence) : "no edge";
        judgements.push({ label, correct, band, actual: [...actualKeys].join(", ") || "(no edges)" });
        if (!correct) {
          mismatches.push(
            `${label.fromFile}::${label.fromSymbol} -> ${label.callName}() [line ${label.callLine.toString()}]: expected edges to {${[...expectedKeys].join(", ")}}, got {${[...actualKeys].join(", ") || "none"}} — ${label.note}`,
          );
        }
        continue;
      }

      if (label.expected === null) {
        const correct = edgesForThisCallName.length === 0;
        judgements.push({ label, correct, band: "n/a (abstention)", actual: correct ? "(no edge)" : edgesForThisCallName.map((e) => `${e.toFile}::${e.toName}`).join(", ") });
        if (!correct) {
          mismatches.push(
            `${label.fromFile}::${label.fromSymbol} -> ${label.callName}() [line ${label.callLine.toString()}]: expected NO edge, got ${edgesForThisCallName.map((e) => `${e.toFile}::${e.toName}@${e.confidence.toString()}`).join(", ")} — ${label.note}`,
          );
        }
        continue;
      }

      const expected = label.expected;
      const match = edgesForThisCallName.find((e) => e.toFile === expected.toFile && e.toName === expected.toSymbol);
      const correct = match !== undefined;
      judgements.push({
        label,
        correct,
        band: match ? bandFor(match.confidence) : "no edge / wrong target",
        actual: edgesForThisCallName.length > 0 ? edgesForThisCallName.map((e) => `${e.toFile}::${e.toName}@${e.confidence.toString()}`).join(", ") : "(no edge)",
      });
      if (!correct) {
        mismatches.push(
          `${label.fromFile}::${label.fromSymbol} -> ${label.callName}() [line ${label.callLine.toString()}]: expected ${expected.toFile}::${expected.toSymbol}, got ${edgesForThisCallName.length > 0 ? edgesForThisCallName.map((e) => `${e.toFile}::${e.toName}`).join(", ") : "no edge"} — ${label.note}`,
        );
      }
    }

    const correctCount = judgements.filter((j) => j.correct).length;
    const precision = correctCount / judgements.length;

    const byBand = new Map<string, { correct: number; total: number }>();
    for (const j of judgements) {
      const entry = byBand.get(j.band) ?? { correct: 0, total: 0 };
      entry.total += 1;
      if (j.correct) entry.correct += 1;
      byBand.set(j.band, entry);
    }

    console.log(`\n=== Call-edge precision: ${correctCount.toString()}/${judgements.length.toString()} = ${(precision * 100).toFixed(1)}% ===\n`);
    console.log("Per-band breakdown:");
    for (const [band, { correct, total }] of [...byBand.entries()].sort((a, b) => b[1].total - a[1].total)) {
      console.log(`  ${band}: ${correct.toString()}/${total.toString()} (${((correct / total) * 100).toFixed(1)}%)`);
    }
    if (mismatches.length > 0) {
      console.log(`\nMismatches (${mismatches.length.toString()}):`);
      for (const m of mismatches) {
        console.log(`  - ${m}`);
      }
    }

    expect(precision).toBeGreaterThanOrEqual(0.7);
  });
});
