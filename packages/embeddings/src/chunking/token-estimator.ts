/**
 * Phase 05 prompt 3, sub-task 3.2 / Claude.md §29 & §2.2 of this prompt: a real BPE
 * tokenizer (tiktoken, gpt-tokenizer) is another dependency and another native/WASM
 * build surface for one estimate that nothing downstream has a hard budget against
 * (`SYMBOL_CHUNK_MAX_TOKENS` etc. are soft ceilings — see `@repo/shared`'s vector.ts).
 * A deterministic character-based estimator is adopted instead, single-sourced here so
 * the chunker, the batcher, and the stored `tokenCount` column never disagree.
 *
 * ## The measured ratio
 *
 * Measured with `gpt-tokenizer` (cl100k_base / GPT-4 encoding) via a throwaway script
 * against all 18 non-empty files in `apps/worker/tests/fixtures/parsing/` (`empty.ts`
 * excluded — zero tokens for zero characters divides by zero and contributes nothing to
 * an aggregate ratio):
 *
 * ```
 * file                          chars  tokens  chars/token
 * abstract-classes.ts             484     110         4.40
 * ambient-declarations.ts         492     110         4.47
 * barrel.ts                       191      47         4.06
 * class-members.ts                635     175         3.63
 * comments-only.ts                156      30         5.20
 * decorators.ts                   570     133         4.29
 * default-exports.ts              267      52         5.13
 * dynamic-imports.ts              458     102         4.49
 * export-star.ts                  198      41         4.83
 * generics.ts                     527     135         3.90
 * jsx-components.tsx              683     169         4.04
 * line-numbers.ts                 230      71         3.24
 * malformed.ts                     83      16         5.19
 * namespace-imports.ts            150      38         3.95
 * object-literal-members.ts       682     165         4.13
 * overloaded-functions.ts         544     108         5.04
 * ts-only-syntax.ts               882     205         4.30
 * type-only-imports.ts            349      85         4.11
 * TOTAL                          7581    1792         4.230
 * ```
 *
 * Aggregate ratio: 7581 chars / 1792 tokens = 4.230 chars/token. Pinned to 4.2 — the
 * spec's own "~3.5 chars/token" figure was a rough prior, not a measurement; this
 * package's fixtures (real TypeScript, moderately commented) measure denser than that.
 * The per-file spread (3.24–5.20) is exactly the ±20% error band §2.2 already accepts:
 * `SYMBOL_CHUNK_MAX_TOKENS` and friends are soft ceilings, not hard budgets.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4.2;

/** Deterministic character-based estimate — see this module's header for the measured
 * ratio and its provenance. `text.length === 0` returns `0` (not padded to `1`) so an
 * empty or whitespace-only chunk candidate is correctly recognized as having no
 * meaningful token cost by 3.4's "empty file → zero chunks" rule. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}
