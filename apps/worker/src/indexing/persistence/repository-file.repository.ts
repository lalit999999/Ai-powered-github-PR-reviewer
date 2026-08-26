import { randomUUID } from "node:crypto";
import { Prisma, prisma } from "@repo/db";
import type { FileClassification, IndexState, ParseState, SkipReason } from "@repo/shared";

/**
 * `plan.md` §8.2 step 6: batched, upsert-based `RepositoryFile` persistence. The
 * *.repository.ts suffix is required by ESLint Rule B (phase-00 §3) — this is the only
 * file in `apps/worker` that may import `@repo/db`'s Prisma-backed exports for this
 * table.
 *
 * ## Upsert strategy — the three options actually weighed, and why raw SQL won
 *
 * The idempotency guarantee an interrupted-and-resumed job depends on (§4 Reliability,
 * `@@unique([repositoryId, path])`) requires an **upsert**, not an insert — a retried
 * step, or a second full index of the same repository, must update existing rows
 * in place rather than either erroring on the unique constraint or leaving duplicates.
 * Three ways to get there, weighed against the §4 "batches of 1,000, never one INSERT
 * per file" requirement:
 *
 * 1. **`createMany({ skipDuplicates: true })`** — rejected outright: `skipDuplicates`
 *    does exactly what its name says, *skip*, not update. A file whose content changed
 *    between two indexes of the same path would silently keep its old `contentHash`
 *    forever. This is wrong, not merely slow.
 * 2. **A transaction of per-row `prisma.repositoryFile.upsert(...)` calls** — correct
 *    (each call really does upsert), but it is exactly the "one write per file" pattern
 *    §4 names as a Phase 3 failure point, just wrapped in a transaction rather than left
 *    bare. 5,000 files means 5,000 round trips either way.
 * 3. **`INSERT ... ON CONFLICT ("repositoryId", "path") DO UPDATE SET ...` via
 *    `$executeRaw`, batched 1,000 rows to a statement** — chosen. One statement upserts
 *    up to 1,000 rows. Every value is bound as a parameter through `Prisma.sql`/`Prisma.join`
 *    (never string-interpolated — `plan.md` §35.11), so this carries the same injection
 *    safety as Prisma's typed API while getting genuine multi-row upsert semantics,
 *    which the typed API has no way to express (`upsert()` is single-row only).
 *
 * ## `parseState`/`symbolCount`/`inboundEdgeCount` are deliberately absent from both the
 * INSERT column list and the `DO UPDATE SET` clause
 *
 * These three columns are Phase 04's to populate (`schema.prisma`'s own comments say
 * so). Omitting them from the INSERT list lets Postgres apply their column `DEFAULT`
 * on a brand-new row; omitting them from `DO UPDATE SET` means a Phase-03-only
 * re-index of an already-parsed repository does not clobber Phase 04's work back to
 * defaults. Phase 04, when it extends this same upsert (or writes its own), is the
 * phase that decides whether re-parsing should reset them — not this one.
 */

export interface RepositoryFileUpsertInput {
  repositoryId: string;
  path: string;
  commitSha: string;
  language: string | null;
  contentHash: string;
  sizeBytes: number;
  lineCount: number;
  packageName: string | null;
  classification: FileClassification;
  indexState: IndexState;
  skipReason: SkipReason | null;
  isTest: boolean;
  isGenerated: boolean;
}

/** `plan.md` §4 Technical Requirements: batch size 1,000. */
export const REPOSITORY_FILE_BATCH_SIZE = 1000;

/**
 * Upserts `files` in batches of {@link REPOSITORY_FILE_BATCH_SIZE}. Batches run
 * sequentially, not in parallel — the driver-adapter connection pool is shared with
 * every other query this Inngest step's surrounding function might make, and a
 * 200,000-file repository firing 200 concurrent multi-row statements would be a
 * self-inflicted connection-pool exhaustion, not a throughput win.
 */
export async function upsertRepositoryFiles(files: readonly RepositoryFileUpsertInput[]): Promise<void> {
  for (let offset = 0; offset < files.length; offset += REPOSITORY_FILE_BATCH_SIZE) {
    const batch = files.slice(offset, offset + REPOSITORY_FILE_BATCH_SIZE);
    await upsertBatch(batch);
  }
}

async function upsertBatch(batch: readonly RepositoryFileUpsertInput[]): Promise<void> {
  if (batch.length === 0) return;

  const now = new Date();
  const rows = Prisma.join(
    batch.map(
      (file) =>
        Prisma.sql`(
          ${randomUUID()},
          ${file.repositoryId},
          ${file.path},
          ${file.commitSha},
          ${file.language},
          ${file.contentHash},
          ${file.sizeBytes},
          ${file.lineCount},
          ${file.packageName},
          ${file.classification}::"FileClassification",
          ${file.indexState},
          ${file.skipReason},
          ${file.isTest},
          ${file.isGenerated},
          ${now}
        )`,
    ),
  );

  // `id` is generated here, in JS, because the column has no database-level default
  // (`schema.prisma`'s `@default(uuid())` is Prisma-client-side codegen, not a Postgres
  // `DEFAULT` — confirmed by reading the migration SQL itself: `"id" TEXT NOT NULL`,
  // nothing else). On a conflict, the freshly-generated id in this statement is simply
  // discarded — `id` is not part of the unique constraint being conflicted on, and is
  // not in the `SET` clause below, so the existing row keeps its original identity.
  await prisma.$executeRaw`
    INSERT INTO "RepositoryFile" (
      "id", "repositoryId", "path", "commitSha", "language", "contentHash",
      "sizeBytes", "lineCount", "packageName", "classification", "indexState",
      "skipReason", "isTest", "isGenerated", "updatedAt"
    )
    VALUES ${rows}
    ON CONFLICT ("repositoryId", "path") DO UPDATE SET
      "commitSha" = EXCLUDED."commitSha",
      "language" = EXCLUDED."language",
      "contentHash" = EXCLUDED."contentHash",
      "sizeBytes" = EXCLUDED."sizeBytes",
      "lineCount" = EXCLUDED."lineCount",
      "packageName" = EXCLUDED."packageName",
      "classification" = EXCLUDED."classification",
      "indexState" = EXCLUDED."indexState",
      "skipReason" = EXCLUDED."skipReason",
      "isTest" = EXCLUDED."isTest",
      "isGenerated" = EXCLUDED."isGenerated",
      "updatedAt" = EXCLUDED."updatedAt"
  `;
}

/**
 * Deletes every `RepositoryFile` row for `repositoryId` whose `commitSha` is not
 * `targetCommitSha` — the stale-row sweep the phase document does not mention (see
 * docs/decisions/phase-03-log.md, "where the phase document is under-specified"). Every
 * row this run touched was just upserted with `commitSha = targetCommitSha`
 * ({@link upsertRepositoryFiles}); anything left behind at an older `commitSha` names a
 * path that existed in a previous index but not this one — deleted from the repository
 * between runs. Without this sweep, a full re-index of a repository with deleted files
 * would accumulate stale rows forever, and §14's "counts match `git ls-files`" check
 * would silently drift wider on every second index.
 *
 * Run **after** every current-commit batch has committed, never before — deleting first
 * would (harmlessly, since the upserts key on `(repositoryId, path)` regardless of
 * `commitSha`) just widen the window where a concurrent read sees neither the old nor
 * the new row for a still-current path, for no benefit.
 */
export async function sweepStaleRepositoryFiles(repositoryId: string, targetCommitSha: string): Promise<number> {
  const result = await prisma.repositoryFile.deleteMany({
    where: { repositoryId, commitSha: { not: targetCommitSha } },
  });
  return result.count;
}

// ---------------------------------------------------------------------------
// Phase 04 — the RepositoryFile graph-metadata update pass (sub-task 4.4)
// ---------------------------------------------------------------------------

/**
 * `symbolCount`/`inboundEdgeCount`/`parseState`/`packageName`/`isTest` are populated
 * meaningfully for the first time by this phase (phase-04 §6/§5 OUTPUT) — this module's
 * own header comment above already named this as the phase and the file that decides how
 * they're maintained; extended in place here rather than a parallel module, per that
 * comment's own instruction.
 *
 * ## `inboundEdgeCount` counts both file-level and symbol-level inbound edges
 *
 * `code-dependency.repository.ts`'s `countInboundEdgesByFile` (the source of the
 * `inboundEdgeCount` value a caller passes in here) unions edges pointing directly at a
 * file (`toFileId`) with edges pointing at any symbol the file `CONTAINS` (`toSymbolId`
 * joined back through `CodeSymbol.fileId`) — see that function's own header for why:
 * counting file-level edges alone would make this metric blind to almost every real
 * dependency, since `CALLS`/`EXTENDS`/`IMPLEMENTS`/`REFERENCES` are all symbol-level, and
 * spec §14's Database Verification requires a shared utility module to score meaningfully
 * higher than a leaf file.
 *
 * ## `packageName` is the *declared* package name, not the directory-derived one
 *
 * `graph-builder.ts` computes this via `repo-context.ts`'s `getPackageNameForFile` (reads
 * the nearest `package.json#name`), upgrading Phase 03's own directory-based
 * `detectPackageName` guess (spec §15's acceptance criterion: "monorepo workspace files
 * are correctly tagged with packageName").
 *
 * ## `isTest` is the caller's already-reconciled value, not re-derived here
 *
 * `graph-builder.ts`'s own `FileGraphMetadata.isTest` is already `pathBased ||
 * frameworkImport` for a successfully parsed file, and the original walk-based value,
 * unchanged, for a FAILED/NOT_PARSED file whose imports were never trusted enough to
 * check (`test-detection.ts`'s own §3.3 doc comment) — this function only ever writes
 * whatever it is given.
 */
export interface RepositoryFileGraphMetadataUpdate {
  fileId: string;
  symbolCount: number;
  inboundEdgeCount: number;
  parseState: ParseState;
  packageName: string | null;
  isTest: boolean;
}

/** Same batch size as {@link upsertRepositoryFiles} — one statement per 1,000 rows,
 * sequential batches (the same shared-connection-pool reasoning applies identically here). */
export async function updateRepositoryFileGraphMetadata(updates: readonly RepositoryFileGraphMetadataUpdate[]): Promise<void> {
  for (let offset = 0; offset < updates.length; offset += REPOSITORY_FILE_BATCH_SIZE) {
    const batch = updates.slice(offset, offset + REPOSITORY_FILE_BATCH_SIZE);
    await updateGraphMetadataBatch(batch);
  }
}

async function updateGraphMetadataBatch(batch: readonly RepositoryFileGraphMetadataUpdate[]): Promise<void> {
  if (batch.length === 0) return;

  // Every value is explicitly cast — a bound parameter carries no type of its own until
  // Postgres infers one from context, and a bare `VALUES (...)` with no surrounding
  // typed column reference infers `text` for everything (confirmed empirically: without
  // these casts, `column "symbolCount" is of type integer but expression is of type
  // text`). The `INSERT ... VALUES` pattern elsewhere in this file never hits this because
  // the target table's column list gives every value an inferred type for free; a
  // `FROM (VALUES ...)` join has no such column list to infer from.
  const rows = Prisma.join(
    batch.map(
      (u) =>
        Prisma.sql`(
          ${u.fileId}::text,
          ${u.symbolCount}::integer,
          ${u.inboundEdgeCount}::integer,
          ${u.parseState}::text,
          ${u.packageName}::text,
          ${u.isTest}::boolean
        )`,
    ),
  );

  await prisma.$executeRaw`
    UPDATE "RepositoryFile" AS rf
    SET
      "symbolCount" = v."symbolCount",
      "inboundEdgeCount" = v."inboundEdgeCount",
      "parseState" = v."parseState",
      "packageName" = v."packageName",
      "isTest" = v."isTest"
    FROM (VALUES ${rows}) AS v(id, "symbolCount", "inboundEdgeCount", "parseState", "packageName", "isTest")
    WHERE rf.id = v.id
  `;
}
