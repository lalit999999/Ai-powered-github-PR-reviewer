import { GRAPH_PROXIMITY, HYBRID_WEIGHTS } from "@repo/shared";
import type { ChunkKind } from "@repo/shared";
import type { ScoredChunk } from "./vector-store.interface.js";

/**
 * Phase 05 prompt 2, sub-task 2.4: `plan.md` §12.4's hybrid scoring formula
 * (phase-05-vector-search.md §10), as a pure, dependency-free module — no Prisma, no
 * I/O, no logger. `hybridSearch` (sub-task 2.5) is this module's only production
 * caller: the SQL computes raw signals (distance, `ts_rank`, `inboundEdgeCount`,
 * `isExported`) and this module turns them into the weighted score. Keeping the
 * arithmetic here rather than in SQL is deliberate — Phase 08/09 tunes these weights
 * from real review data (`plan.md` §15.5: "you'll tune the weights from real reviews,
 * and you can't tune what you didn't log"), and a formula buried in a SQL statement is
 * neither unit-testable nor tunable without a migration.
 *
 * score = 0.45·vectorScore + 0.20·graphProximity + 0.15·lexicalScore
 *       + 0.10·recencyOrImportance + 0.10·pathAffinity
 */

// ---------------------------------------------------------------------------
// vectorScore
// ---------------------------------------------------------------------------

/**
 * `embedding <=> $1` (pgvector cosine distance) ranges `[0, 2]`, not `[0, 1]` and not a
 * similarity. `1 - distance` is the naive conversion a reviewer expects, but it goes
 * negative for any distance above 1 (a legal, unremarkable `<=>` output for a dissimilar
 * pair) and would silently corrupt the weighted sum below, which assumes every term is
 * in `[0, 1]`. The correct affine map is `[0, 2] -> [1, 0]`; clamped defensively for
 * floating-point overshoot right at the boundary.
 */
export function normalizeVectorScore(distance: number): number {
  const score = 1 - distance / 2;
  return Math.min(1, Math.max(0, score));
}

// ---------------------------------------------------------------------------
// lexicalScore
// ---------------------------------------------------------------------------

/**
 * `ts_rank` is unbounded above and typically tiny for real matches (commonly
 * 0.0–0.1) — contributed directly at weight 0.15, it would be decorative, not a real
 * signal. Normalized **within the candidate set** instead: divided by the maximum
 * `ts_rank` present in the current result union, so the best lexical match in *this*
 * query scores 1.0 and the rest scale relative to it. This is a real design decision,
 * not an obvious one — it means lexical score measures "how good a match is this,
 * relative to the best match this query found," not an absolute, cross-query-comparable
 * quantity. `maxTsRankInSet <= 0` (no lexical matches at all, or a stopword-only query)
 * returns 0 for everyone rather than dividing by zero.
 */
export function normalizeLexicalScore(
  tsRank: number,
  maxTsRankInSet: number,
): number {
  if (maxTsRankInSet <= 0) return 0;
  return Math.min(1, Math.max(0, tsRank / maxTsRankInSet));
}

// ---------------------------------------------------------------------------
// graphProximity
// ---------------------------------------------------------------------------

/**
 * Looks up the caller-supplied `filePath -> proximity` map (see
 * `vector-store.interface.ts`'s header comment for why this store never computes graph
 * proximity itself). No entry — including the common case of no map supplied at all —
 * falls back to `GRAPH_PROXIMITY.NONE` (0.1): a flat, uninformative signal, not a bug.
 * With no graph input, the other four terms alone decide the ranking.
 */
export function graphProximityFor(
  filePath: string,
  provided: Readonly<Record<string, number>> | undefined,
): number {
  return provided?.[filePath] ?? GRAPH_PROXIMITY.NONE;
}

// ---------------------------------------------------------------------------
// recencyOrImportance
// ---------------------------------------------------------------------------

/**
 * Spec §10 defines this term as "churn rate / export-ness / fan-in." Churn does not
 * exist in this system yet — no commit history is stored; Phase 14 (incremental
 * indexing) is where that arrives. Fan-in **does** exist, as
 * `RepositoryFile.inboundEdgeCount` (populated by Phase 04). Export-ness is
 * `CodeSymbol.isExported`. This input type carries only the two signals available
 * today, so adding churn later is a field addition to this interface, not a rewrite of
 * every call site.
 */
export interface RecencyImportanceInput {
  inboundEdgeCount: number;
  isExported: boolean;
}

/**
 * Equal-weight blend of the two available signals. Spec §10 names three inputs
 * ("churn rate / export-ness / fan-in") but gives no sub-weights, and with churn absent
 * there is no basis yet for weighting fan-in and export-ness unevenly — an even split is
 * the least-assuming choice until real data (or churn's later addition) argues
 * otherwise. `maxInboundEdgeCountInSet <= 0` guards the same divide-by-zero case
 * {@link normalizeLexicalScore} does.
 */
const FAN_IN_WEIGHT = 0.5;
const EXPORT_WEIGHT = 0.5;

export function recencyOrImportance(
  input: RecencyImportanceInput,
  maxInboundEdgeCountInSet: number,
): number {
  const fanIn =
    maxInboundEdgeCountInSet <= 0
      ? 0
      : Math.min(
          1,
          Math.max(0, input.inboundEdgeCount / maxInboundEdgeCountInSet),
        );
  const exportSignal = input.isExported ? 1 : 0;
  return FAN_IN_WEIGHT * fanIn + EXPORT_WEIGHT * exportSignal;
}

// ---------------------------------------------------------------------------
// pathAffinity
// ---------------------------------------------------------------------------

export const PATH_AFFINITY_TIERS = {
  SAME_DIRECTORY: 1.0,
  SAME_PACKAGE: 0.5,
  OTHER: 0,
  /**
   * No reference path was supplied at all (the debug-search panel has no "changed
   * file" to compare against — spec §7's query is just free text). This is
   * deliberately the numeric midpoint of the 0..1 range, not 0: a term that is 0 for
   * every candidate contributes nothing to *ranking* (every candidate is equally
   * penalized) but does depress every candidate's absolute score by the same amount,
   * which makes score values across different queries incomparable in the logs the
   * whole formula exists to be tuned from (`plan.md` §15.5). It happens to equal
   * `SAME_PACKAGE` numerically — that is a coincidence of both being "half credit,"
   * not a reason they are the same constant; they are kept separate so either can
   * move independently.
   */
  NO_REFERENCE: 0.5,
} as const;

function directoryOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "" : filePath.slice(0, idx);
}

/**
 * `queryPath === null` means the caller supplied no reference path at all (see
 * `PATH_AFFINITY_TIERS.NO_REFERENCE`). Otherwise: same directory scores 1.0, same
 * package (and a known, non-null package for the chunk) scores 0.5, anything else
 * scores 0.
 */
export function pathAffinity(
  chunkPath: string,
  queryPath: string | null,
  chunkPackage: string | null,
  queryPackage: string | null,
): number {
  if (queryPath === null) return PATH_AFFINITY_TIERS.NO_REFERENCE;
  if (directoryOf(chunkPath) === directoryOf(queryPath)) {
    return PATH_AFFINITY_TIERS.SAME_DIRECTORY;
  }
  if (chunkPackage !== null && chunkPackage === queryPackage) {
    return PATH_AFFINITY_TIERS.SAME_PACKAGE;
  }
  return PATH_AFFINITY_TIERS.OTHER;
}

// ---------------------------------------------------------------------------
// scoreChunk — the weighted sum
// ---------------------------------------------------------------------------

export interface HybridScoreComponents {
  vectorScore: number;
  graphProximity: number;
  lexicalScore: number;
  recencyOrImportance: number;
  pathAffinity: number;
}

export function scoreChunk(components: HybridScoreComponents): number {
  return (
    HYBRID_WEIGHTS.vectorScore * components.vectorScore +
    HYBRID_WEIGHTS.graphProximity * components.graphProximity +
    HYBRID_WEIGHTS.lexicalScore * components.lexicalScore +
    HYBRID_WEIGHTS.recencyOrImportance * components.recencyOrImportance +
    HYBRID_WEIGHTS.pathAffinity * components.pathAffinity
  );
}

// ---------------------------------------------------------------------------
// rescoreAndRank
// ---------------------------------------------------------------------------

/**
 * The raw, per-candidate signals `hybridSearch`'s SQL (sub-task 2.5) produces from the
 * union of its vector and lexical CTEs. `distance`/`tsRank` are `null` when a candidate
 * has no value for that signal — a lexical-only match against a chunk with no embedding
 * yet (the PARTIAL/resume path, §4 Reliability) has `distance: null`; a vector-only
 * match that the lexical query did not touch has `tsRank: null`. Both are treated as "no
 * evidence," never a fabricated 0 distance or rank.
 */
export interface HybridCandidate {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  chunkKind: ChunkKind;
  content: string;
  symbols: string[];
  packageName: string | null;
  distance: number | null;
  tsRank: number | null;
  inboundEdgeCount: number;
  isExported: boolean;
}

export interface RescoreContext {
  graphProximityByFilePath?: Readonly<Record<string, number>>;
  /** The changed/reference file's path and package, for {@link pathAffinity}. `null`
   * (not merely absent) when the caller has no reference path — see
   * `PATH_AFFINITY_TIERS.NO_REFERENCE`. */
  queryFilePath: string | null;
  queryPackageName: string | null;
  limit: number;
}

/**
 * Applies the set-relative normalizations ({@link normalizeLexicalScore},
 * {@link recencyOrImportance}'s fan-in term), scores every candidate, and returns the
 * top {@link RescoreContext.limit}, sorted by descending score. Ties break on ascending
 * `id` — a documented, deterministic tiebreak, since two candidates can legitimately
 * compute the exact same score and the union's own row order (a database result set) is
 * not a meaningful or stable ordering to fall back on.
 */
export function rescoreAndRank(
  candidates: readonly HybridCandidate[],
  context: RescoreContext,
): ScoredChunk[] {
  if (candidates.length === 0) return [];

  let maxTsRank = 0;
  let maxInboundEdgeCount = 0;
  for (const candidate of candidates) {
    if (candidate.tsRank !== null && candidate.tsRank > maxTsRank) {
      maxTsRank = candidate.tsRank;
    }
    if (candidate.inboundEdgeCount > maxInboundEdgeCount) {
      maxInboundEdgeCount = candidate.inboundEdgeCount;
    }
  }

  const scored = candidates.map((candidate): ScoredChunk => {
    const vectorScore =
      candidate.distance === null
        ? 0
        : normalizeVectorScore(candidate.distance);
    const graphProximity = graphProximityFor(
      candidate.filePath,
      context.graphProximityByFilePath,
    );
    const lexicalScore =
      candidate.tsRank === null
        ? 0
        : normalizeLexicalScore(candidate.tsRank, maxTsRank);
    const recency = recencyOrImportance(
      {
        inboundEdgeCount: candidate.inboundEdgeCount,
        isExported: candidate.isExported,
      },
      maxInboundEdgeCount,
    );
    const affinity = pathAffinity(
      candidate.filePath,
      context.queryFilePath,
      candidate.packageName,
      context.queryPackageName,
    );
    const score = scoreChunk({
      vectorScore,
      graphProximity,
      lexicalScore,
      recencyOrImportance: recency,
      pathAffinity: affinity,
    });

    return {
      id: candidate.id,
      filePath: candidate.filePath,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      chunkKind: candidate.chunkKind,
      content: candidate.content,
      symbols: candidate.symbols,
      score,
      vectorScore,
      graphProximity,
      lexicalScore,
      recencyOrImportance: recency,
      pathAffinity: affinity,
    };
  });

  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return scored.slice(0, context.limit);
}
