# Why tree-sitter, and why the call resolver is heuristic on purpose

This document exists for one reason, stated in `phase-04-code-parsing-and-knowledge-graph.md`
§16: to write down the tree-sitter-vs-compiler-API trade-off and the precision target
**where a future engineer might otherwise be tempted to "fix" the heuristic resolver
without understanding why over-fetch-then-rank (Phase 08) makes that unnecessary.** If you
are reading this because a call-resolution edge looks wrong, read the whole thing before
changing `call-resolver.ts` — the imprecision is a designed trade-off, not a bug queue.

## Why tree-sitter, not `ts-morph` or the TypeScript compiler API

|                      | tree-sitter                                                                 | `ts-morph` / TS compiler API                                     |
| -------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Speed                | ~10–50 MB/s, one host process, any number of languages                      | Type-checking a large monorepo costs tens of seconds to minutes  |
| Dependencies         | None — parses raw text                                                      | Needs a resolvable `node_modules` install                        |
| Error tolerance      | Parses broken/mid-refactor code; produces a partial tree with `ERROR` nodes | A file with a real syntax error often fails to type-check at all |
| Resolution precision | Heuristic, name-based (~70–98% measured — see below)                        | ~99%, compiler-exact                                             |
| Multi-language       | One grammar per language, same host process                                 | TS/JS-specific tooling; a different story per language           |

The disqualifying constraint is the "needs a resolvable `node_modules` install" row.
Phase 03's indexing pipeline deliberately never runs `npm install`/`pnpm install` against
a fetched repository — that would mean executing third-party `postinstall` scripts against
attacker-controlled code, which `plan.md` §35.6 rules out outright (no repository code is
ever executed, full stop). Without an install, `ts-morph`/the compiler API cannot resolve
module imports across package boundaries at all, which is most of what this phase's graph
is _for_. Tree-sitter needs no install, tolerates broken code (a `git clone` mid-refactor
is a completely normal state to index), and is roughly two orders of magnitude faster —
paying 50× the cost for compiler-exact resolution would be a bad trade at this stage, not
a free upgrade.

## Why ~70% (measured: 98%) call precision is acceptable by design

`plan.md` §1.3 change ⑤ (Decision D3) names this trade-off explicitly: heuristic,
name-based call resolution at an accepted ~65–80% target, instead of ~99%
compiler-exact resolution. The reason it is _acceptable_, not merely _tolerated_, is
architectural: **Phase 08's Context Engine is designed to over-fetch and re-rank**, not to
trust any single edge as ground truth. A wrong or missing `CALLS` edge degrades retrieval
quality gracefully — a slightly worse candidate set for the ranker to work with — rather
than corrupting an answer the way it would in a system that treated the graph as
authoritative. Chasing this number toward 100% inside `call-resolver.ts` would mean
building (or bolting on) real type-aware resolution, which reopens the "needs a resolvable
install" problem the tool choice above exists to avoid, for a precision gain the
downstream system is specifically built not to need.

The heuristic's own design already reflects this trade-off rather than fighting it: rule 4
(ambiguous 2–3 candidates) hedges by emitting an edge to _every_ plausible candidate at
reduced confidence, rather than guessing one; rule 4's `N > 3` variant skips entirely
rather than guessing among many. Both are the same underlying judgment as the
over-fetch-then-rank design one layer up: when the resolver is not confident, more signal
(or no signal) beats one wrong, confident-looking signal.

## Measured precision (Phase 04 Prompt 5, sub-task 5.2)

Measured against 100 manually labeled call sites in
`apps/worker/tests/fixtures/graph-repo/` (see that fixture's own `MANIFEST.md` and
`graph-repo-labels.json`'s `methodology` field for how the labels were produced — read the
source independently, _then_ compared against the resolver's real output, never the
reverse). `apps/worker/tests/integration/call-precision.test.ts` asserts ≥70% and reruns
this measurement on every `test:integration` run.

**Overall: 98/100 = 98.0%.**

| Band             | Rule                                                 | Labeled | Correct | Precision |
| ---------------- | ---------------------------------------------------- | ------- | ------- | --------- |
| n/a (abstention) | correct "no edge" (built-ins, genuine N>3 ambiguity) | 41      | 41      | 100.0%    |
| 0.95             | `SAME_FILE`                                          | 35      | 35      | 100.0%    |
| 0.90             | `NAMED_IMPORT`                                       | 15      | 15      | 100.0%    |
| 0.70             | `UNIQUE_REPO_MATCH`                                  | 4       | 4       | 100.0%    |
| <0.50            | `AMBIGUOUS_TIEBREAK`                                 | 3       | 3       | 100.0%    |
| —                | wrong target / missing edge                          | 2       | 0       | 0.0%      |

Every one of the 2 misses is a genuine, understood resolver limitation, not noise — see
"Known gaps" below. Both were _discovered_ while building the label set (not assumed and
then confirmed), by reading the fixture source and reasoning about what the resolver
_should_ find versus what it actually produced.

**Why the measured number is well above the 70% target, not merely over it:** the fixture
repository (`tests/fixtures/graph-repo/`) was deliberately built to exercise every hard
case the resolver's own rules name — tsconfig alias collisions, cross-package workspace
imports, ESM `.js`→`.ts` interop, a three-deep class hierarchy, ambiguous same-package
collisions at N=2, N=3, and N=4 — and every one of those _known-hard_ cases still resolved
correctly. The two misses are cases the resolver's own documented rules were never
designed to handle (a re-export chased more than one hop; an aliased import's local name
not matching its target's declared name), not failures of the rules the resolver does
implement. A larger, more chaotic real-world repository would likely show a lower number
than this curated fixture — the 70% target exists precisely because real code will hit
messier shapes than a hand-built fixture, however hard that fixture tries.

## The confidence values, and what they mean to Phase 08's ranking

The five confidence constants (`call-resolver.ts`) are not decorative — they are the
contract Phase 08's Context Engine ranks retrieval by (`plan.md` §11.5: "ORDER BY
confidence DESC" is the literal query shape `graph-queries.repository.ts`'s
`getInboundCallers` uses). A caller of that query should read the bands as:

- **0.95 (`SAME_FILE`)** — trust this like a compiler would; the only way it is wrong is a
  genuine same-file name collision, vanishingly rare in practice.
- **0.9 (`NAMED_IMPORT`)** — trust this almost as much; the one hop of re-export chasing
  the resolver does _not_ do (see below) is the main source of a false negative here, never
  a false positive.
- **0.7 (`UNIQUE_REPO_MATCH`)** — a real signal, but no import ties it to the call site
  explicitly; treat it as strong-but-not-certain.
- **`0.4/N` (`AMBIGUOUS_TIEBREAK`)** — genuinely uncertain by construction; Phase 08 should
  weight these low and lean on other signal (text similarity, proximity) to break the tie
  further, not treat any single one as "the" answer.
- **No edge at all** — either nothing to find, or `N > 3` ambiguity. Phase 08 cannot
  distinguish these two from the graph alone; if that distinction ever matters, it would
  need to come from `skippedForAmbiguity`-style telemetry, not a `CodeDependency` row.

## The N>3 rule, and why ambiguity is worse than absence

`plan.md` §11.4 rule 4's own framing: when narrowing (same package, then same top-level
directory) still leaves more than `CALL_AMBIGUITY_MAX_CANDIDATES` (3) plausible targets,
the resolver produces **no edge at all**, rather than guessing or fanning out to every
candidate. The reasoning is asymmetric with the N≤3 case on purpose: a fan-out to 2–3
candidates at reduced confidence is still useful signal (Phase 08 can rank among a small,
named set); a fan-out to, say, 12 candidates would just be noise dressed up as a graph
edge, indistinguishable from real signal to a ranker that trusts confidence scores. No
edge, honestly representing "the resolver does not know," is more useful downstream than
12 low-confidence edges that look like 12 independent pieces of evidence.

Verified as actually engaging, not just unit-tested: the fixture repository's
`src/api/handler.ts` calls a bare `render()` with four same-named, same-bucket candidates
repo-wide; `apps/worker/tests/integration/graph-fixture.test.ts` asserts zero `CALLS` edges
from that call site, and `graph-builder.ts`'s own `call resolution completed` log line
(`skippedForAmbiguity`) confirms the skip path fired, not some other reason for the absent
edge.

## Known gaps — accepted, not silently missing

Every item below is a real, understood limitation the precision measurement either
surfaced directly or already accounted for. None of them are secretly failing silently —
each produces the honest, safe outcome (no edge, or a documented lower-confidence edge),
never a wrong one.

- **Re-exports are chased one hop, never transitively.** A barrel file's
  `export * from "./x"` produces a real `IMPORTS` edge to `./x` (see `docs/indexing.md`),
  but the barrel's own `symbols` list is empty — it declares nothing itself. A caller that
  imports a name _through_ the barrel (`import { login } from "@pkg/core"`, where `@pkg/core`
  resolves to the barrel, and the barrel only re-exports `login`) will not resolve that
  call: rule 2's target-file lookup finds no `login` symbol in the barrel, and re-exports
  are not chased further. Measured directly: `apps/web/src/main.ts`'s `login()` call in the
  fixture repository is exactly this shape, and is one of the two precision misses above.
  A fix exists (walk `ParsedExport.reExportFrom` chains at resolution time) but was not
  built — it adds real complexity (cycle detection, depth bounds) for a case Phase 08's
  over-fetch-then-rank design already tolerates.
- **An aliased import's local name is not reconciled against its target's declared name.**
  `import { handler as webhookHandler } from "./webhooks/handler"` binds the call site to
  the name `webhookHandler`, but rule 2 then searches the target file for a symbol
  literally named `webhookHandler` — which does not exist there; the target's own name is
  `handler`. `ParsedImport.named` only carries the local (possibly aliased) binding, not
  the original exported name, so rule 2 has no way to recover it. This is the second
  measured miss above — discovered while labeling, not previously known, and a genuinely
  new finding from this measurement rather than a pre-documented gap. A fix would mean the
  adapter capturing both names per specifier and rule 2 preferring the original name for
  the target-file lookup; not built this prompt, since precision already clears the target
  without it.
- **Heritage rule 2 (`NAMED_IMPORT`) excludes type-only imports.** `resolveHeritageName`'s
  own named-import check requires `!i.isTypeOnly`, so a very common real-world shape
  (`import type { Middleware } from "./middleware-types"; class X implements Middleware`)
  falls through to rule 3 instead — still resolves correctly if the interface is unique in
  the caller's package bucket, at 0.7 confidence instead of 0.9. Demonstrated directly in
  the fixture repository (`packages/core/src/http/middleware.ts`), and _not_ counted as a
  miss in the precision measurement — the edge still resolves, just at a different
  (accurate) confidence.
- **`new Foo()` constructor calls have no observable signal.** Prompt 2's tree-sitter
  queries capture `call_expression` only — there is no `new_expression` pattern — so rule
  5's "imported **or** instantiated" receiver check can only ever check the "imported"
  half. A class instantiated only through a local factory/variable with no direct import of
  the class name in the calling file will fail rule 5 and fall through to ambiguity
  handling. A recall gap (fewer edges), never a precision one (no wrong edges).
  (`call-resolver.ts`'s own header comment; recorded in `docs/decisions/phase-04-log.md`,
  Prompt 3 §4.)
- **A repeated, identical call site within one symbol is captured only once.** Discovered
  while building the fixture repository's own call-density (not by the precision
  measurement's labels, which only label captured call sites): a method that calls the
  same target twice, by name, with no distinguishing receiver
  (`this.bump(); this.bump();`) produces exactly one `ParsedCall`, not two — the second,
  syntactically identical call site is dropped somewhere between the tree-sitter query
  match and the adapter's per-symbol `calls` array. Confirmed reproducible (not a fixture
  artifact) with two independent examples
  (`packages/core/src/models/entity.ts`'s `bumpTwice`,
  `src/components/button-render.ts`'s `renderTwice` — see
  `apps/worker/tests/fixtures/graph-repo/`). This affects **edge cardinality**, not
  correctness of the edges that do exist (the one captured call resolves correctly), and
  it was out of this prompt's own scope to fix — it lives in Prompt 2's adapter, not the
  resolver this prompt measures.
- **`packages/utils/src/formatters/date-formatter.ts`'s receiver-capture quirk.** A chained
  call whose object is itself a `call_expression` (`body.replace(...).trim()`) is captured
  with an **empty** receiver, rather than the object's own text — unlike a `new
Expression().method()` chain, which captures correctly. Does not affect any measured
  outcome (no repo symbol collides with the affected call names either way), but is a real
  parsing-layer imprecision worth a future prompt's attention if receiver text is ever
  relied on more heavily than it is today.

## What a V2 "precision mode" would look like

`plan.md` §10.5 names this directly: an opt-in, index-time-only, TS-only "precision mode"
using `ts-morph` or the TypeScript Language Service for genuinely type-aware resolution,
for repositories where the ~98%-on-good-code/lower-on-real-world-chaos heuristic ceiling is
not good enough. Sketch, not a commitment:

- Opt-in per repository (a `Repository` setting), never the default — it requires a real
  `npm install`/`pnpm install` against the fetched tree, which reopens the "never execute
  repository code" posture this phase avoids; it would need its own sandboxing story
  before shipping.
- TS-only, since the compiler API/`ts-morph` has no equivalent for JS-without-types beyond
  what `tsc --checkJs` already does today, and Python/Go are already out of MVP scope.
- Runs _instead of_, not _alongside_, the heuristic resolver for a given repository — two
  disagreeing sources of `CALLS` edges for the same graph would be worse than either alone.
- The confidence scale would likely collapse to a single high value (compiler-verified
  resolution has no meaningful "ambiguous" tier the way the heuristic does) — Phase 08
  would need to know which mode produced a given repository's edges, since a `0.95` from
  `SAME_FILE` and a `0.95` from a compiler-verified V2 mode carry different actual
  certainty even though they're numerically equal today.

Not built in Phase 04, and per this document's own opening paragraph: building it because
one repository's precision number looks lower than another's is very likely the wrong
move — check whether Phase 08's ranking is actually starved for precision first.
