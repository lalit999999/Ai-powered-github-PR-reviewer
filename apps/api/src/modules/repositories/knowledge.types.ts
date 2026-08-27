/**
 * Domain types for the repository knowledge module (Phase 04 Prompt 5, sub-task 5.4).
 * Deliberately dependency-free, matching `repository.types.ts`: the repository layer
 * (`knowledge.repository.ts`) imports these record shapes, never the other way round.
 */

export interface KnowledgeFileTotals {
  fileCount: number;
  parseStateCounts: Record<string, number>;
}

export interface KnowledgeEdgeTotals {
  edgeCount: number;
  edgeCountByKind: Record<string, number>;
  unresolvedImportRatio: number;
}

export interface TopUnresolvedSpecifierRecord {
  rawSpecifier: string | null;
  count: number;
}

export interface TopFileByInboundEdgesRecord {
  fileId: string;
  path: string;
  inboundEdgeCount: number;
}

export interface KnowledgeAggregates {
  fileTotals: KnowledgeFileTotals;
  symbolCount: number;
  edgeTotals: KnowledgeEdgeTotals;
  topUnresolvedSpecifiers: TopUnresolvedSpecifierRecord[];
  topFilesByInboundEdges: TopFileByInboundEdgesRecord[];
}

/**
 * `GET /api/repositories/:id/knowledge`'s response DTO (phase-04 §7, enriched per this
 * prompt's own §7 framing: "useful enough to build now and keep"). `BigInt` never reaches
 * this boundary — every count here is a plain `number`, converted at the repository layer
 * (`knowledge.repository.ts`'s own `Number(row.count)` calls), the same discipline
 * `RepositoryDto`'s own doc comment established for `installationId`/`githubRepoId`.
 */
export interface TopFileByInboundEdges {
  fileId: string;
  path: string;
  inboundEdgeCount: number;
}

export interface TopUnresolvedSpecifier {
  rawSpecifier: string | null;
  count: number;
}

export interface RepositoryKnowledgeDto {
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  unresolvedImportRatio: number;
  topFilesByInboundEdges: TopFileByInboundEdges[];
  /** §7's own five fields, plus this prompt's documented enrichment: */
  edgeCountByKind: Record<string, number>;
  parseStateCounts: Record<string, number>;
  /** Substitutes for §7's `unresolvedByReason` — see `knowledge.repository.ts`'s
   * `getTopUnresolvedSpecifiers` doc comment for why (no `UnresolvedReason` union exists
   * anywhere in this codebase to key it on). Empty when the repository has no unresolved
   * imports at all. */
  topUnresolvedSpecifiers: TopUnresolvedSpecifier[];
}

function toTopFileByInboundEdgesDto(record: TopFileByInboundEdgesRecord): TopFileByInboundEdges {
  return { fileId: record.fileId, path: record.path, inboundEdgeCount: record.inboundEdgeCount };
}

function toTopUnresolvedSpecifierDto(record: TopUnresolvedSpecifierRecord): TopUnresolvedSpecifier {
  return { rawSpecifier: record.rawSpecifier, count: record.count };
}

export function toRepositoryKnowledgeDto(aggregates: KnowledgeAggregates): RepositoryKnowledgeDto {
  return {
    fileCount: aggregates.fileTotals.fileCount,
    symbolCount: aggregates.symbolCount,
    edgeCount: aggregates.edgeTotals.edgeCount,
    unresolvedImportRatio: aggregates.edgeTotals.unresolvedImportRatio,
    topFilesByInboundEdges: aggregates.topFilesByInboundEdges.map(toTopFileByInboundEdgesDto),
    edgeCountByKind: aggregates.edgeTotals.edgeCountByKind,
    parseStateCounts: aggregates.fileTotals.parseStateCounts,
    topUnresolvedSpecifiers: aggregates.topUnresolvedSpecifiers.map(toTopUnresolvedSpecifierDto),
  };
}
