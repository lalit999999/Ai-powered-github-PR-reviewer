import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DisconnectRepositoryButton } from "@/components/repository/disconnect-repository-button";
import type { Repository } from "@/lib/api";

/**
 * Every `IndexStatus` value gets a caption, even though only `PENDING` is reachable
 * this phase (phase-02 §11) — `INDEXING`/`INDEXED`/`FAILED`/`PARTIAL`/`UPDATING` arrive
 * with Phase 03's real progress reporting, and this card should not need restructuring
 * to grow a progress bar or a "view index" link then; it should only need a new branch
 * in this map and whatever Phase 03 wants to render next to it.
 */
const INDEX_STATUS_CAPTIONS: Record<string, string> = {
  PENDING: "Waiting to be indexed",
  INDEXING: "Indexing…",
  INDEXED: "Indexed",
  UPDATING: "Updating index…",
  FAILED: "Indexing failed",
  PARTIAL: "Indexed (partial)",
};

export function RepositoryCard({ repository }: { repository: Repository }) {
  const statusCaption = INDEX_STATUS_CAPTIONS[repository.indexStatus] ?? repository.indexStatus;

  return (
    <Card id={`repository-${repository.id}`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <a
            href={repository.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate hover:underline"
          >
            {repository.fullName}
          </a>
          <Badge variant={repository.isPrivate ? "secondary" : "outline"}>
            {repository.isPrivate ? "Private" : "Public"}
          </Badge>
          {repository.connectionStatus === "ACCESS_LOST" && <Badge variant="destructive">Access lost</Badge>}
        </CardTitle>
        <CardDescription>Default branch: {repository.defaultBranch}</CardDescription>
        <CardAction>
          <DisconnectRepositoryButton repositoryId={repository.id} />
        </CardAction>
      </CardHeader>
      <CardContent>
        <Badge variant="outline">{statusCaption}</Badge>
      </CardContent>
    </Card>
  );
}
