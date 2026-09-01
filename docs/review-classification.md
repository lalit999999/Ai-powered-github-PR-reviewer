# Changed-file classification, review depth, and the hard caps (Phase 07)

The classification -> `reviewDepth` mapping and the hard caps, written down in one place
so Phase 09's fan-out logic and Phase 12's UI can both reference it without re-deriving
it — spec §16's own requirement. This is the docs counterpart to
`apps/worker/src/indexing/filter/file-classifier.ts` (classification/depth),
`apps/worker/src/review/priority-score.ts` (the priority formula), and
`apps/worker/src/review/file-manifest.ts` (caps and ordering) — those files are the one
place in *code* each rule lives; this is the one place in *docs*.

## The classification -> depth table

Every `PullRequestFile.classification` value (the same `FileClassification` enum
`RepositoryFile.classification` uses — `packages/db/prisma/schema.prisma`) maps to a
`ReviewDepth`. `classifyChangedFile(path)` (`file-classifier.ts`) computes the
classification from the path alone — a diff entry has no content `Buffer`, size, or
package roots, so it reuses `detectLanguage`/`detectIsTest`/`detectIsGenerated`/
`classifyFile`, the same path-only primitives `classify()` composes for a full repository
index, rather than a second classification pipeline that could disagree with the first.

| Classification    | Detection rule                                                             | `ReviewDepth`                                  |
| ------------------ | --------------------------------------------------------------------------- | ----------------------------------------------- |
| `SOURCE`           | A recognized-language extension, nothing more specific matched              | `DEEP`                                          |
| `TEST`              | Path/filename matches a test convention (`__tests__/`, `*.test.ts`, ...)   | `SHALLOW`                                       |
| `CONFIG`            | A recognized config filename/extension (`package.json`, `*.config.ts`, ...) | `SHALLOW`                                       |
| `GENERATED`         | Path/filename matches a generated convention (`*.generated.ts`, ...)       | `SKIP`                                          |
| `DEPENDENCY_LOCK`   | A known lockfile name (`pnpm-lock.yaml`, `package-lock.json`, ...)          | `SKIP`                                          |
| `DOCUMENTATION`     | `.md`/`.mdx`/`.rst`/`.txt`                                                   | `SHALLOW`                                       |
| `ASSET`             | A known binary/asset extension (`.png`, `.pdf`, `.wasm`, ...)              | `SKIP`                                          |
| `UNKNOWN`           | No other rule matched                                                       | `SHALLOW` if `changedLines < 500`, else `SKIP`  |

`UNKNOWN` is the one row not in `CLASSIFICATION_REVIEW_DEPTH` itself (`@repo/shared`,
`packages/shared/src/reviews.ts`) — its depth depends on the size of *this PR's* diff, not
the classification alone, so `decideReviewDepth` (`file-classifier.ts`) special-cases it
rather than the shared table trying to encode a conditional.

## Status overrides — checked before classification, in this order

`decideReviewDepth`'s first argument is `PullRequestFileStatus` (`@repo/shared`) — GitHub's
own seven-value `status` field on a changed-file entry. A status override can force `SKIP`
(or fall through to the table above) before classification is even consulted:

| `status`                                 | Depth                        | Why                                                                                                                                                        |
| ----------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `removed`                                  | `SKIP`                        | Never sent to the file reviewer. "Who still imports this?" is a graph question, answered deterministically by Phase 10 — not something an LLM needs to guess at. |
| `renamed`, no content change (`additions === 0 && deletions === 0`) | `SKIP` | Nothing to review; the importer-update check is Phase 10's deterministic job, not a diff-review question. |
| `unchanged`                                | `SKIP`                        | Nothing changed.                                                                                                                                              |
| `copied`                                   | falls through to classification | Treated as `added`, per `plan.md` §16.5 — the source path is noted in the review prompt (Phase 09's concern, not this decision's).                          |
| `renamed`, **with** content change         | falls through to classification | The content diff is reviewed normally; `previousPath` is what Phase 08 uses to find the old file's symbols in the graph.                                    |
| `added` / `modified` / `changed`           | falls through to classification | The ordinary path.                                                                                                                                             |

If no status override fired, one more check runs before the table above: `!hasPatch` ->
`SKIP`. `hasPatch` is false when GitHub omitted the `patch` field on this changed-file
entry (a binary file, or a diff over GitHub's own per-file patch size cap) — there is
nothing to review without content, regardless of classification.

## The hard caps

| Cap                                | Value       | Constant (`@repo/shared`, `packages/shared/src/reviews.ts`) | Behaviour on exceed                                                                                                     |
| ------------------------------------ | ------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Files fetched from GitHub            | 3,000        | `MAX_FILES_FETCHED`                                              | GitHub's own hard cap on `GET /pulls/{n}/files` — this system cannot see a file past it regardless of what it wants.  |
| Files considered for review          | 300          | `MAX_FILES_CONSIDERED`                                           | Every file at rank >= 300 (by priority, see below) is forced to `reviewDepth: "SKIP"`. It still gets a manifest row — never dropped — so the UI can show an accurate total. |
| Deep files                           | 40           | `MAX_DEEP_FILES`                                                 | Every `DEEP`-eligible file beyond the first 40 (within the 300 considered) demotes to `SHALLOW` — **never** to `SKIP`. A huge PR still gets a lighter pass on every considered file, not silence past the cutoff. |
| Oversized single-file diff           | 1,500 lines  | `OVERSIZED_FILE_DIFF_LINES`                                      | `ManifestFile.oversized` is set to true. Detection only, in this phase — splitting an oversized diff into reviewable pieces is Phase 08's job (spec §3 Out of Scope). |
| Inline patch size                    | 64 KiB       | `PATCH_INLINE_MAX_BYTES`                                         | At or under: stored inline on `PullRequestFile.patchRef`. Over: written to `PatchBlob` instead (`apps/worker/src/lib/patch-store.ts`, Phase 07 Prompt 1). |

Both file-count caps are applied in `buildManifest` (`review/file-manifest.ts`) over the
**sorted** file list — see "Ordering" below — never over GitHub's own response order,
which is unspecified and not something a re-run of the same review should depend on.

## The priority formula

`computePriorityScore` (`review/priority-score.ts`), `plan.md` §16.3's formula
implemented literally, six weighted terms summing to at most 100:

| Term                                   | Weight | Signal                                                                                     |
| ---------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| Classification is `SOURCE`               | 40     | `PullRequestFile.classification`                                                              |
| Inbound edge count, normalized           | 25     | `RepositoryFile.inboundEdgeCount` (Phase 04), normalized against this PR's own maximum         |
| Touches a security-sensitive path        | 15     | `SECURITY_SENSITIVE_PATH` (`review/priority-score.ts`) — auth/payment/admin/crypto/middleware/policy/permission/credential/secret/token |
| Churn (`additions + deletions`), normalized | 10  | Normalized against this PR's own maximum churn                                                |
| Exports a public API surface             | 5      | At least one `CodeSymbol.isExported` row for the file (Phase 04)                              |
| No test file linked                      | 5      | The **absence** of a `TESTS`-kind `CodeDependency` edge pointing at the file (Phase 04) — inverted on purpose, since untested code changing is riskier than tested code changing |

Rounded once with `Math.round`, over the summed score — never per term — then clamped to
`[0, 100]`.

**Normalization is within-PR, not repository-wide.** `normalized(x) = min(1, x / max(1,
context.max))`, where `context.max` (`maxInboundEdgeCount` / `maxChurn`) is the maximum of
that signal across *this review's own changed files*, computed once by
`buildPriorityContext`. A repository-wide or global denominator would flatten every file
in a small PR toward zero on both normalized terms, collapsing the whole ranking onto the
`SOURCE` bit alone — a PR's job is to rank its own files against each other, not against
the repository as a whole. Within-PR normalization is also deterministic and
self-contained: unit-testable without seeding a repository, unlike a repository-wide
denominator, which is itself a query result. `buildPriorityContext` returns at least `1`
for both maximums (even on an all-zero file set), so normalization never divides by zero.

`SECURITY_SENSITIVE_PATH` is exported from `review/priority-score.ts` specifically so
Phase 10's secret scanning can reuse the identical definition rather than inventing a
second one that could silently drift from this one.

## Ordering, and where a review's fan-out sequence comes from

`buildManifest` sorts every changed file by `priorityScore` descending, tie-broken by
`path` ascending, **before** either cap is applied. The tie-break is not cosmetic:
without it, ordering would depend on GitHub's own (unspecified) response order, and two
runs of the same review could apply the caps differently. This sorted order is also
Prompt 4's Inngest fan-out order — a change to the sort comparator changes which files
get reviewed first, and therefore which files a binding cap demotes, on any PR large
enough for the caps to matter.

## Where to make each kind of change

- **Add or change a file extension's language** -> `EXTENSION_LANGUAGE` in
  `apps/worker/src/indexing/filter/file-classifier.ts`. `classifyChangedFile` picks it up
  automatically — it calls the same `detectLanguage`.
- **Add or change a test/generated/config/documentation/asset/lockfile convention** -> the
  relevant pattern/set in `file-classifier.ts` (`TEST_PATH_SEGMENT`, `GENERATED_FILENAME`,
  `CONFIG_FILENAME`, `DOCUMENTATION_EXTENSIONS`, `ASSET_EXTENSIONS`,
  `DEPENDENCY_LOCK_FILENAME`). Same file for both index-time and review-time
  classification — there is only one place to edit.
- **Change a classification's default review depth** -> `CLASSIFICATION_REVIEW_DEPTH` in
  `packages/shared/src/reviews.ts`, plus this document's table above. `UNKNOWN`'s
  size-dependent rule lives in `decideReviewDepth` (`file-classifier.ts`) instead, since it
  isn't a fixed per-classification mapping.
- **Change a status override** (e.g. what happens to `copied`) -> `decideReviewDepth` in
  `file-classifier.ts`, plus the status-override table above.
- **Change a cap's value** -> the constant in `packages/shared/src/reviews.ts`
  (`MAX_FILES_FETCHED` / `MAX_FILES_CONSIDERED` / `MAX_DEEP_FILES` /
  `OVERSIZED_FILE_DIFF_LINES` / `PATCH_INLINE_MAX_BYTES`) — nowhere else. `file-manifest.ts`
  imports and applies them; it never re-declares a threshold locally.
- **Change the priority formula** (a weight, a term, the security-path regex, the
  normalization strategy) -> `review/priority-score.ts`, plus this document's formula
  table and normalization section — both need to change together, since this document is
  the only place the reasoning behind the within-PR normalization choice is written down
  outside the module's own comments.
- **Change cap ordering or the sort/tiebreak** -> `buildManifest` in
  `review/file-manifest.ts`, plus "Ordering" above — this is also Phase 09's fan-out
  order, so treat it as a review-outcome change, not a refactor.
