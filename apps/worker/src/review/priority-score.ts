import type { FileClassification } from "@repo/shared";

/**
 * The per-file priority formula — `plan.md` §44's `review/priority-score.ts`, Prompt 3 of
 * phase-07-pr-ingestion.md sub-task 3.4. Pure: every graph signal is passed **in**, never
 * queried here — the database read that gathers `inboundEdgeCount`/`exportsPublicApi`/
 * `noTestLinked` belongs to Prompt 4's Inngest step, not this module.
 *
 * `plan.md` §16.3's formula, implemented literally:
 *
 *   priority = 40 * (classification === "SOURCE")
 *            + 25 * normalized(inboundEdgeCount)
 *            + 15 * (touches a security-sensitive path)
 *            + 10 * normalized(churn = additions + deletions)
 *            +  5 * (file exports a public API surface)
 *            +  5 * (no test file linked)
 */

// ---------------------------------------------------------------------------
// Security-sensitive paths — a shared constant, not a formula-local heuristic
// ---------------------------------------------------------------------------

/** plan.md §16.3: auth/, payment/, admin/, crypto, middleware, *policy*, *permission*.
 * Exported so Phase 10's secret scanning can reuse the identical definition rather than
 * inventing a second one. Segment-anchored for the directory-style keywords (so
 * `src/author/x.ts` and `docs/authority.md` do NOT match — "auth" must be a whole path
 * segment, not a substring of a longer word); the second group
 * (`policy|permission|credential|secret|token`) is intentionally a plain substring match,
 * since those terms show up as filename suffixes (`rbac-policy.ts`) as often as directory
 * names. */
export const SECURITY_SENSITIVE_PATH =
  /(^|\/)(auth|authn|authz|payment|payments|billing|admin|crypto|security|middleware)(\/|$)|(policy|permission|credential|secret|token)/i;

export function touchesSecuritySensitivePath(path: string): boolean {
  return SECURITY_SENSITIVE_PATH.test(path);
}

// ---------------------------------------------------------------------------
// computePriorityScore
// ---------------------------------------------------------------------------

export interface PriorityInput {
  path: string;
  classification: FileClassification;
  additions: number;
  deletions: number;
  /** `RepositoryFile.inboundEdgeCount` for this path at the indexed commit; 0 when the
   * file is new (added) or simply not in the index. Phase 04 populates this column. */
  inboundEdgeCount: number;
  /** True when the indexed file has at least one exported symbol. Phase 04 signal
   * (`CodeSymbol.isExported`, any row for this file). */
  exportsPublicApi: boolean;
  /** True when NO test file is linked to this file in the graph (Phase 04's `TESTS`
   * dependency edges). Note the inversion: the ABSENCE of a test raises priority, because
   * untested code changing is riskier than tested code changing. */
  noTestLinked: boolean;
}

export interface PriorityContext {
  /** The maximum `inboundEdgeCount` across THIS review's changed files, at least 1. */
  maxInboundEdgeCount: number;
  /** The maximum churn (`additions + deletions`) across THIS review's changed files, at
   * least 1. */
  maxChurn: number;
}

/**
 * Normalises `x` against `max` within `[0, 1]`, against **this PR's own file set**
 * (`PriorityContext`), never a repository-wide or global constant. A PR's job is to rank
 * *its own* files against each other; a repository-wide normaliser would flatten every
 * file in a small PR toward zero on both the inbound-edge and churn terms, collapsing the
 * whole ranking onto the `SOURCE` bit alone. Within-PR normalisation is also
 * deterministic and self-contained — unit-testable without seeding a repository — which a
 * repository-wide denominator (itself a query result) would not be. `max` is always at
 * least 1 ({@link buildPriorityContext} guarantees it), so this never divides by zero.
 */
function normalized(x: number, max: number): number {
  return Math.min(1, x / Math.max(1, max));
}

/** Integer 0–100, stored in `PullRequestFile.priorityScore`. Rounded once, at the very
 * end, over the summed weighted terms — not per term — and clamped to `[0, 100]` as a
 * final safety net against a caller-supplied out-of-range input (e.g. a negative churn,
 * which should never happen but must not produce a negative score if it does). */
export function computePriorityScore(input: PriorityInput, context: PriorityContext): number {
  const churn = input.additions + input.deletions;

  const score =
    40 * (input.classification === "SOURCE" ? 1 : 0) +
    25 * normalized(input.inboundEdgeCount, context.maxInboundEdgeCount) +
    15 * (touchesSecuritySensitivePath(input.path) ? 1 : 0) +
    10 * normalized(churn, context.maxChurn) +
    5 * (input.exportsPublicApi ? 1 : 0) +
    5 * (input.noTestLinked ? 1 : 0);

  return Math.min(100, Math.max(0, Math.round(score)));
}

/** Derives {@link PriorityContext} from the whole changed-file set in one pass. Both
 * maximums start at 1 (never 0) so {@link normalized} can never divide by zero, including
 * on an all-zero set (every file newly added with 0 inbound edges, or a PR with only
 * deletions). */
export function buildPriorityContext(files: readonly PriorityInput[]): PriorityContext {
  let maxInboundEdgeCount = 1;
  let maxChurn = 1;
  for (const file of files) {
    if (file.inboundEdgeCount > maxInboundEdgeCount) maxInboundEdgeCount = file.inboundEdgeCount;
    const churn = file.additions + file.deletions;
    if (churn > maxChurn) maxChurn = churn;
  }
  return { maxInboundEdgeCount, maxChurn };
}
