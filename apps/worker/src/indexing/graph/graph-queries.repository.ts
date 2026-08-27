import { Prisma, prisma } from "@repo/db";

/**
 * Phase 04 prompt 4, sub-task 4.5: `plan.md` §11.5's graph queries, plus the aggregate
 * counts prompt 5's knowledge panel needs. **Named `graph-queries.repository.ts`, not
 * `graph-queries.ts`** as spec §18 literally names it — this module runs SQL, and ESLint
 * Rule B (phase-00 §3) restricts `@repo/db` access to `packages/db/**` or a
 * `*.repository.ts` file. This rename was decided in prompt 1 §2.2, recorded here as the
 * module that actually acts on it.
 *
 * Every query is scoped by `repositoryId` in its `WHERE` clause — the tenant-isolation
 * boundary at the data layer (this module's own test suite seeds two repositories and
 * asserts no query ever returns the other's rows, the same adversarial pattern
 * `apps/api/tests/integration/cross-tenant.test.ts` already uses).
 *
 * Every value is bound through `Prisma.sql`/tagged-template parameters — never
 * string-interpolated (`plan.md` §35.11).
 */

// ---------------------------------------------------------------------------
// Query 1 — inbound callers of a set of symbols, depth 1 (plan.md §11.5)
// ---------------------------------------------------------------------------

export interface InboundCallerRow {
  dependencyId: string;
  kind: string;
  fromSymbolId: string;
  toSymbolId: string;
  confidence: number;
  symbolName: string;
  filePath: string;
}

/** The kinds `plan.md` §11.5 names for "who is affected if this symbol changes" — the
 * impact set Phase 08's Context Engine ranks by `confidence DESC`. */
const INBOUND_CALLER_KINDS = Prisma.sql`('CALLS','REFERENCES','EXTENDS','IMPLEMENTS')`;

/** Default matches `plan.md` §11.5's own example (`LIMIT 50`) and §9's "20 callers" cap
 * for the Context Engine's own step 5 — callers needing a different cap pass one. */
export const DEFAULT_INBOUND_CALLER_LIMIT = 50;

export async function getInboundCallers(
  repositoryId: string,
  symbolIds: readonly string[],
  limit: number = DEFAULT_INBOUND_CALLER_LIMIT,
): Promise<InboundCallerRow[]> {
  if (symbolIds.length === 0) return [];

  return prisma.$queryRaw<InboundCallerRow[]>`
    SELECT
      d.id AS "dependencyId",
      d.kind AS "kind",
      d."fromSymbolId" AS "fromSymbolId",
      d."toSymbolId" AS "toSymbolId",
      d.confidence AS "confidence",
      s.name AS "symbolName",
      f.path AS "filePath"
    FROM "CodeDependency" d
    JOIN "CodeSymbol" s ON s.id = d."fromSymbolId"
    JOIN "RepositoryFile" f ON f.id = s."fileId"
    WHERE d."toSymbolId" = ANY(${symbolIds})
      AND d.kind::text IN ${INBOUND_CALLER_KINDS}
      AND d."repositoryId" = ${repositoryId}
    ORDER BY d.confidence DESC
    LIMIT ${limit}
  `;
}

// ---------------------------------------------------------------------------
// Query 2 — files importing a file, depth 2, with distance (plan.md §11.5)
// ---------------------------------------------------------------------------

export interface DependentFileRow {
  fileId: string;
  depth: number;
}

/** `plan.md` §11.5's own literal depth cap. */
export const DEFAULT_DEPENDENT_DEPTH = 2;

/**
 * Recursive CTE, cycle-safe via `UNION` (not `UNION ALL`) — a circular import graph is
 * normal in real repositories (spec §12's own error-handling table: "no special handling
 * needed", the two-pass design already makes edges correct in both directions) and would
 * not terminate under `UNION ALL`, which never de-duplicates the `(file_id, depth)` pairs
 * a cycle keeps re-emitting. `UNION`'s own de-duplication is exactly what stops the
 * recursion once every reachable file at every depth up to the bound has been seen once.
 */
export async function getFilesImportingFile(
  repositoryId: string,
  fileId: string,
  maxDepth: number = DEFAULT_DEPENDENT_DEPTH,
): Promise<DependentFileRow[]> {
  return prisma.$queryRaw<DependentFileRow[]>`
    WITH RECURSIVE dependents AS (
      SELECT "fromFileId" AS file_id, 1 AS depth
      FROM "CodeDependency"
      WHERE "toFileId" = ${fileId} AND kind = 'IMPORTS' AND "repositoryId" = ${repositoryId}
      UNION
      SELECT d."fromFileId", dep.depth + 1
      FROM "CodeDependency" d
      JOIN dependents dep ON d."toFileId" = dep.file_id
      WHERE d.kind = 'IMPORTS' AND d."repositoryId" = ${repositoryId} AND dep.depth < ${maxDepth}
    )
    SELECT file_id AS "fileId", MIN(depth)::int AS "depth" FROM dependents GROUP BY file_id
  `;
}

// ---------------------------------------------------------------------------
// Query 3 — knowledge-panel aggregates (phase-04 §3/§7's debug endpoint)
// ---------------------------------------------------------------------------

export interface TopFileByInboundEdges {
  fileId: string;
  path: string;
  inboundEdgeCount: number;
}

export interface KnowledgeGraphSummary {
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  /** `UNRESOLVED` / (`RESOLVED` + `EXTERNAL` + `UNRESOLVED`) among `IMPORTS` edges only —
   * spec §20's own metric, computed fresh from persisted rows rather than trusted from
   * whatever `graph-builder.ts` logged at index time, since this is what the debug panel
   * and Phase 08 read *after* the run, independently of that log line. */
  unresolvedImportRatio: number;
  topFilesByInboundEdges: TopFileByInboundEdges[];
}

const DEFAULT_TOP_FILES_LIMIT = 10;

export async function getKnowledgeGraphSummary(repositoryId: string, topFilesLimit: number = DEFAULT_TOP_FILES_LIMIT): Promise<KnowledgeGraphSummary> {
  const [fileCountRow] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "RepositoryFile" WHERE "repositoryId" = ${repositoryId}
  `;
  const [symbolCountRow] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "CodeSymbol" WHERE "repositoryId" = ${repositoryId}
  `;
  const [edgeCountRow] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "CodeDependency" WHERE "repositoryId" = ${repositoryId}
  `;
  const [importRatioRow] = await prisma.$queryRaw<{ resolved: bigint; external: bigint; unresolved: bigint }[]>`
    SELECT
      COUNT(*) FILTER (WHERE resolution = 'RESOLVED')::bigint AS resolved,
      COUNT(*) FILTER (WHERE resolution = 'EXTERNAL')::bigint AS external,
      COUNT(*) FILTER (WHERE resolution = 'UNRESOLVED')::bigint AS unresolved
    FROM "CodeDependency"
    WHERE "repositoryId" = ${repositoryId} AND kind = 'IMPORTS'
  `;
  const topFilesByInboundEdges = await prisma.$queryRaw<TopFileByInboundEdges[]>`
    SELECT id AS "fileId", path, "inboundEdgeCount"
    FROM "RepositoryFile"
    WHERE "repositoryId" = ${repositoryId}
    ORDER BY "inboundEdgeCount" DESC, path ASC
    LIMIT ${topFilesLimit}
  `;

  const resolved = Number(importRatioRow?.resolved ?? 0n);
  const external = Number(importRatioRow?.external ?? 0n);
  const unresolved = Number(importRatioRow?.unresolved ?? 0n);
  const importTotal = resolved + external + unresolved;

  return {
    fileCount: Number(fileCountRow?.count ?? 0n),
    symbolCount: Number(symbolCountRow?.count ?? 0n),
    edgeCount: Number(edgeCountRow?.count ?? 0n),
    unresolvedImportRatio: importTotal === 0 ? 0 : unresolved / importTotal,
    topFilesByInboundEdges,
  };
}
