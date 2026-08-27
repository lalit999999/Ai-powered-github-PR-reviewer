"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { API_URL } from "@/lib/api-url";
import type { RepositoryKnowledge } from "@/lib/api";

/**
 * The repository "knowledge" panel (phase-04 §3): file/symbol/edge counts, the
 * unresolved-import ratio, parse-state counts, and the top files by inbound edges. Built
 * as the phase's own debugging UI, not a polished product surface — §3 says so directly.
 *
 * Follows `index-status-poller.tsx`'s established conventions: `"use client"`,
 * `@tanstack/react-query`, a `credentials: "include"` fetch against `API_URL` (the
 * server-side `apiFetch` helper in `lib/api.ts` reads `next/headers` and only works in a
 * Server Component, so this component's own fetcher is local, exactly like
 * `fetchIndexStatus`).
 *
 * ## No polling, unlike the index-status card
 *
 * These numbers are static once indexing finishes — a full re-index is the only thing
 * that changes them, and that already reloads the page (`IndexStatusPoller`'s own
 * `router.refresh()` on retry). One fetch, with a manual "Refresh" button for the rare
 * case of wanting a second look without a full page reload.
 */

const UNRESOLVED_RATIO_WARNING_THRESHOLD = 0.15;

async function fetchKnowledge(
  repositoryId: string,
): Promise<RepositoryKnowledge> {
  const res = await fetch(
    `${API_URL}/api/repositories/${encodeURIComponent(repositoryId)}/knowledge`,
    {
      credentials: "include",
    },
  );
  if (!res.ok) {
    throw new Error(`Could not load the knowledge graph (${res.status})`);
  }
  return (await res.json()) as RepositoryKnowledge;
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function KnowledgePanel({
  repositoryId,
  indexStatus,
}: {
  repositoryId: string;
  indexStatus: string;
}) {
  // A knowledge panel showing zeroes mid-index reads as a bug — only ever render once
  // indexing has actually finished (§3's own framing: "this doubles as your debugging
  // UI", not a live progress view — IndexStatusPoller already owns that).
  const enabled = indexStatus === "INDEXED";

  const { data, error, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["repository-knowledge", repositoryId],
    queryFn: () => fetchKnowledge(repositoryId),
    enabled,
    staleTime: Infinity,
    retry: 1,
  });

  if (!enabled) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>Knowledge graph</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </CardTitle>
        <CardDescription>
          Symbols and dependency edges extracted from this repository&apos;s
          source.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            Could not load the knowledge graph.{" "}
            {error instanceof Error ? error.message : ""}
          </p>
        )}

        {data && <KnowledgeBody data={data} />}
      </CardContent>
    </Card>
  );
}

function KnowledgeBody({ data }: { data: RepositoryKnowledge }) {
  if (data.symbolCount === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No knowledge graph yet — this repository was indexed before Phase 04
        shipped, or its parse produced no symbols. Re-index to build it.
      </p>
    );
  }

  const unresolvedRatioIsHigh =
    data.unresolvedImportRatio > UNRESOLVED_RATIO_WARNING_THRESHOLD;
  const failedFiles = data.parseStateCounts.FAILED ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-3 gap-4">
        <Stat label="Files" value={data.fileCount} />
        <Stat label="Symbols" value={data.symbolCount} />
        <Stat label="Edges" value={data.edgeCount} />
      </div>

      <div>
        <p className="text-sm font-medium">Unresolved-import ratio</p>
        <div className="mt-1 flex items-center gap-2">
          <Badge variant={unresolvedRatioIsHigh ? "destructive" : "outline"}>
            {formatPercent(data.unresolvedImportRatio)}
          </Badge>
          {unresolvedRatioIsHigh && (
            <span className="text-xs text-destructive">
              Above the 15% health threshold — usually a missed tsconfig read or
              an unusual bundler alias.
            </span>
          )}
        </div>
        {data.topUnresolvedSpecifiers.length > 0 && (
          <ul className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground">
            {data.topUnresolvedSpecifiers.slice(0, 5).map((s) => (
              <li key={s.rawSpecifier ?? "(none)"}>
                {s.count}× {s.rawSpecifier ?? "(no specifier recorded)"}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-sm font-medium">Edges by kind</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {Object.entries(data.edgeCountByKind).map(([kind, count]) => (
            <Badge key={kind} variant="secondary">
              {kind}: {count}
            </Badge>
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-medium">Parse state</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {Object.entries(data.parseStateCounts).map(([state, count]) => (
            <Badge
              key={state}
              variant={
                state === "FAILED" && count > 0 ? "destructive" : "outline"
              }
            >
              {state}: {count}
            </Badge>
          ))}
        </div>
        {failedFiles > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            {failedFiles} file{failedFiles === 1 ? "" : "s"} failed to parse and
            stayed text-indexed only.
          </p>
        )}
      </div>

      <div>
        <p className="text-sm font-medium">Top files by inbound edges</p>
        {data.topFilesByInboundEdges.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            No inbound edges recorded.
          </p>
        ) : (
          <Table className="mt-1">
            <TableHeader>
              <TableRow>
                <TableHead>Path</TableHead>
                <TableHead className="text-right">Inbound edges</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.topFilesByInboundEdges.map((file) => (
                <TableRow key={file.fileId}>
                  <TableCell className="font-mono text-xs">
                    {file.path}
                  </TableCell>
                  <TableCell className="text-right">
                    {file.inboundEdgeCount}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-2xl font-semibold tabular-nums">
        {value.toLocaleString()}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
