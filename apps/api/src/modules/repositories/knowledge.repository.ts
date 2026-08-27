import { prisma } from "@repo/db";
import type {
  KnowledgeAggregates,
  KnowledgeEdgeTotals,
  KnowledgeFileTotals,
  TopFileByInboundEdgesRecord,
  TopUnresolvedSpecifierRecord,
} from "./knowledge.types.js";

/**
 * Prompt 5, sub-task 5.4: the aggregate queries behind `GET /api/repositories/:id/knowledge`
 * (phase-04 §7). Rule B (phase-00 §3): only `*.repository.ts` or `packages/db/**` may
 * import `@repo/db`'s Prisma-backed exports — this is that file for the knowledge module.
 * Imports its record shapes from `knowledge.types.ts` rather than declaring them here,
 * matching `repository.repository.ts`'s own convention: the repository layer imports
 * types, never the other way round.
 *
 * **"One round trip if you can manage it"** (phase-04 §7's own framing) is read as "no
 * N+1" rather than literally one query: the payload spans three unrelated tables
 * (`RepositoryFile`, `CodeSymbol`, `CodeDependency`), so a single query joining all three
 * would be a much more expensive full scan/join for no real benefit over four small,
 * independently-indexed aggregates run in parallel. What this module never does is loop
 * and query per row — every aggregate here is one `GROUP BY`/`COUNT` statement, run once,
 * regardless of how large the repository is.
 */

export async function getFileTotals(
  repositoryId: string,
): Promise<KnowledgeFileTotals> {
  const rows = await prisma.$queryRaw<{ parseState: string; count: bigint }[]>`
    SELECT "parseState", COUNT(*) AS count
    FROM "RepositoryFile"
    WHERE "repositoryId" = ${repositoryId}
    GROUP BY "parseState"
  `;

  const parseStateCounts: Record<string, number> = {};
  let fileCount = 0;
  for (const row of rows) {
    const count = Number(row.count);
    parseStateCounts[row.parseState] = count;
    fileCount += count;
  }
  return { fileCount, parseStateCounts };
}

export async function getSymbolCount(repositoryId: string): Promise<number> {
  const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "CodeSymbol" WHERE "repositoryId" = ${repositoryId}
  `;
  return Number(row?.count ?? 0n);
}

/**
 * One `GROUP BY (kind, resolution)` statement produces everything the payload needs about
 * edges: the total count (summed), the per-kind breakdown, and the unresolved-import ratio
 * (derived from the `IMPORTS` kind's own rows) — all from the same result set, no second
 * query needed for any of the three.
 */
export async function getEdgeTotals(
  repositoryId: string,
): Promise<KnowledgeEdgeTotals> {
  const rows = await prisma.$queryRaw<
    { kind: string; resolution: string; count: bigint }[]
  >`
    SELECT kind::text AS kind, resolution, COUNT(*) AS count
    FROM "CodeDependency"
    WHERE "repositoryId" = ${repositoryId}
    GROUP BY kind, resolution
  `;

  const edgeCountByKind: Record<string, number> = {};
  let edgeCount = 0;
  let importsResolved = 0;
  let importsExternal = 0;
  let importsUnresolved = 0;

  for (const row of rows) {
    const count = Number(row.count);
    edgeCountByKind[row.kind] = (edgeCountByKind[row.kind] ?? 0) + count;
    edgeCount += count;
    if (row.kind === "IMPORTS") {
      if (row.resolution === "RESOLVED") importsResolved += count;
      else if (row.resolution === "EXTERNAL") importsExternal += count;
      else if (row.resolution === "UNRESOLVED") importsUnresolved += count;
    }
  }

  const importTotal = importsResolved + importsExternal + importsUnresolved;
  const unresolvedImportRatio =
    importTotal === 0 ? 0 : importsUnresolved / importTotal;

  return { edgeCount, edgeCountByKind, unresolvedImportRatio };
}

const TOP_UNRESOLVED_LIMIT = 20;

/**
 * `phase-04…md` §7 asks for the payload to answer "which specifiers failed and why" via an
 * `unresolvedByReason` field keyed on a `Prompt 3 UnresolvedReason` union — no such union
 * exists anywhere in this codebase (`import-resolver.ts`'s `ImportResolution` carries only
 * `{status: "UNRESOLVED", specifier}`, no reason code). The nearest real, honest substitute
 * is this: the top unresolved raw specifiers by count, the same shape sub-task 5.3(b)'s own
 * ad-hoc SQL uses — it answers the identical actionable question ("which imports, and how
 * often") without inventing a classification the resolver never actually produces. See
 * docs/decisions/phase-04-log.md for this conflict and its resolution.
 */
export async function getTopUnresolvedSpecifiers(
  repositoryId: string,
): Promise<TopUnresolvedSpecifierRecord[]> {
  const rows = await prisma.$queryRaw<
    { rawSpecifier: string | null; count: bigint }[]
  >`
    SELECT "rawSpecifier", COUNT(*) AS count
    FROM "CodeDependency"
    WHERE "repositoryId" = ${repositoryId} AND resolution = 'UNRESOLVED'
    GROUP BY "rawSpecifier"
    ORDER BY count DESC
    LIMIT ${TOP_UNRESOLVED_LIMIT}
  `;
  return rows.map((row) => ({
    rawSpecifier: row.rawSpecifier,
    count: Number(row.count),
  }));
}

const TOP_FILES_LIMIT = 10;

export async function getTopFilesByInboundEdges(
  repositoryId: string,
): Promise<TopFileByInboundEdgesRecord[]> {
  const rows = await prisma.repositoryFile.findMany({
    where: { repositoryId },
    select: { id: true, path: true, inboundEdgeCount: true },
    orderBy: [{ inboundEdgeCount: "desc" }, { path: "asc" }],
    take: TOP_FILES_LIMIT,
  });
  return rows.map((row) => ({
    fileId: row.id,
    path: row.path,
    inboundEdgeCount: row.inboundEdgeCount,
  }));
}

/**
 * The one function `repository.service.ts` calls — runs every aggregate above in
 * parallel. `getTopUnresolvedSpecifiers` is skipped entirely (not just filtered
 * client-side) when `getEdgeTotals` already reports zero unresolved imports, the common
 * case for a well-formed repository — one fewer round trip on the path that matters most.
 */
export async function getKnowledgeAggregates(
  repositoryId: string,
): Promise<KnowledgeAggregates> {
  const [fileTotals, symbolCount, edgeTotals, topFilesByInboundEdges] =
    await Promise.all([
      getFileTotals(repositoryId),
      getSymbolCount(repositoryId),
      getEdgeTotals(repositoryId),
      getTopFilesByInboundEdges(repositoryId),
    ]);

  const topUnresolvedSpecifiers =
    (edgeTotals.edgeCountByKind.IMPORTS ?? 0) > 0 &&
    edgeTotals.unresolvedImportRatio > 0
      ? await getTopUnresolvedSpecifiers(repositoryId)
      : [];

  return {
    fileTotals,
    symbolCount,
    edgeTotals,
    topUnresolvedSpecifiers,
    topFilesByInboundEdges,
  };
}
