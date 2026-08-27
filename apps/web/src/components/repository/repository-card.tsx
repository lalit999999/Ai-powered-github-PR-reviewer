import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DisconnectRepositoryButton } from "@/components/repository/disconnect-repository-button";
import { IndexStatusPoller } from "@/components/repository/index-status-poller";
import { KnowledgePanel } from "@/components/repository/knowledge-panel";
import type { IndexStatus, Repository } from "@/lib/api";

/**
 * Exactly the prediction phase-02's own doc comment made here: "this card should not
 * need restructuring to grow a progress bar... only a new branch in this map [not true
 * any more — see below] and whatever Phase 03 wants to render next to it." What
 * actually shipped is even smaller than that — the static caption map moved to
 * `index-status-poller.tsx` (it now needs to react to *live*, polled status, not just
 * this page-load snapshot), and the one line that used to render a plain `Badge` here
 * now renders `IndexStatusPoller` instead. Nothing else in this file changed.
 *
 * `initialStatus` is deliberately just `repository.indexStatus` plus safe zero/`null`
 * defaults for the fields this list endpoint doesn't carry (`currentStep`,
 * `progressPercent`, `filesTotal`, `filesProcessed`) — exactly the shape
 * `getIndexStatus`'s own "no IndexJob yet" fallback produces (apps/api). If a job is
 * already mid-run when this card first renders, this under-reports progress for at
 * most one poll interval (2s) before the poller's first live fetch corrects it — a
 * deliberate trade-off against fetching every card's `/index-status` a second time
 * server-side just to seed a number that self-corrects almost immediately anyway.
 */
function toInitialStatus(repository: Repository): IndexStatus {
  return {
    status: repository.indexStatus,
    currentStep: null,
    progressPercent: 0,
    filesTotal: 0,
    filesProcessed: 0,
    error: repository.indexError,
  };
}

export function RepositoryCard({ repository }: { repository: Repository }) {
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
          {repository.connectionStatus === "ACCESS_LOST" && (
            <Badge variant="destructive">Access lost</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Default branch: {repository.defaultBranch}
        </CardDescription>
        <CardAction>
          <DisconnectRepositoryButton repositoryId={repository.id} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <IndexStatusPoller
          repositoryId={repository.id}
          initialStatus={toInitialStatus(repository)}
        />
        <KnowledgePanel
          repositoryId={repository.id}
          indexStatus={repository.indexStatus}
        />
      </CardContent>
    </Card>
  );
}
