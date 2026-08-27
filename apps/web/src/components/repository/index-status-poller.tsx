"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { API_URL } from "@/lib/api-url";
import type { IndexStatus } from "@/lib/api";

/**
 * Live progress for one repository's index, polling `GET /api/repositories/:id/index-status`
 * (phase-03 §3/§18). Renders every `IndexStatus` value the enum carries — `PENDING`,
 * `INDEXING`, `INDEXED`, `FAILED`, plus `UPDATING`/`PARTIAL`, which no writer produces
 * yet this phase but which the client must still render sensibly rather than fall
 * through to a raw enum string.
 *
 * `repository-card.tsx`'s own doc comment predicted this exact shape of extension
 * (phase-02): "a new branch in the map and whatever Phase 03 wants to render next to
 * it." This component IS that — `RepositoryCard` swaps its old static `Badge` for this,
 * unchanged otherwise.
 *
 * ## Polling cadence — a decision, not react-query's default
 *
 * - **2 seconds while `INDEXING`/`UPDATING`** — frequent enough that a progress bar
 *   reads as "live" without re-fetching on every render.
 * - **Stops entirely once terminal** (`INDEXED`/`FAILED`) — `refetchInterval` returns
 *   `false` rather than a number, so a dashboard with many open repository cards does
 *   not poll forever after every one of them finishes. A `PENDING`/`PARTIAL` card still
 *   polls (waiting to start / a state this phase never produces but should not go
 *   stale if a later phase does).
 * - **Paused when the tab is hidden** — `refetchIntervalInBackground` is left at
 *   react-query's own default (`false`), which already stops firing while the document
 *   is not visible; no extra wiring needed, verified against the installed
 *   `@tanstack/react-query` version's own default rather than assumed.
 * - **A network error never blanks the UI** — react-query keeps the last successful
 *   `data` on a failed refetch (`initialData` seeds the very first render so there is
 *   never a loading flash either); a small inline note appears instead of losing the
 *   last-known progress.
 */

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(["INDEXED", "FAILED"]);

const STATUS_CAPTIONS: Record<string, string> = {
  PENDING: "Waiting to be indexed",
  INDEXING: "Indexing…",
  INDEXED: "Indexed",
  UPDATING: "Updating index…",
  FAILED: "Indexing failed",
  PARTIAL: "Indexed (partial)",
};

/**
 * §12's user-visible column, one entry per `IndexErrorCode` this phase's own pipeline
 * can produce, plus `UNKNOWN` for anything uncoded. `UNSAFE_ARCHIVE` is deliberately
 * generic — "do not surface attack details to the UI" is §12's own instruction, and the
 * API side already keeps the underlying message generic (repository-index.ts's
 * `withCode("UNSAFE_ARCHIVE", "The archive failed a safety check")`); this map does not
 * even read `error.message` for that code, so a future change to the API's own message
 * text could not accidentally leak something new through this component.
 */
interface ErrorInfo {
  message: string;
  action: "retry" | "reconnect";
}

const DEFAULT_ERROR_INFO: ErrorInfo = {
  message: "Indexing failed.",
  action: "retry",
};

const ERROR_MESSAGES: Record<string, ErrorInfo> = {
  REPO_NOT_FOUND: {
    message: "GitHub can no longer find this repository.",
    action: "reconnect",
  },
  REPO_TOO_LARGE: {
    message: "Repository exceeds the current size limit.",
    action: "retry",
  },
  UNSAFE_ARCHIVE: { message: "Indexing failed.", action: "retry" },
  ACCESS_REVOKED: {
    message: "GitHub access was revoked for this installation.",
    action: "reconnect",
  },
  TARBALL_DOWNLOAD_FAILED: {
    message: "Could not download the repository from GitHub.",
    action: "retry",
  },
};

function errorCodeOf(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "UNKNOWN";
}

async function fetchIndexStatus(repositoryId: string): Promise<IndexStatus> {
  const res = await fetch(
    `${API_URL}/api/repositories/${encodeURIComponent(repositoryId)}/index-status`,
    {
      credentials: "include",
    },
  );
  if (!res.ok) {
    throw new Error(`Could not load index status (${res.status})`);
  }
  return (await res.json()) as IndexStatus;
}

export function IndexStatusPoller({
  repositoryId,
  initialStatus,
}: {
  repositoryId: string;
  initialStatus: IndexStatus;
}) {
  const router = useRouter();
  const [retryPending, setRetryPending] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const { data, isError } = useQuery({
    queryKey: ["repository-index-status", repositoryId],
    queryFn: () => fetchIndexStatus(repositoryId),
    initialData: initialStatus,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && TERMINAL_STATUSES.has(status) ? false : POLL_INTERVAL_MS;
    },
    retry: 3,
  });

  async function handleRetry() {
    setRetryPending(true);
    setRetryError(null);
    try {
      const res = await fetch(
        `${API_URL}/api/repositories/${encodeURIComponent(repositoryId)}/index`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "FULL" }),
        },
      );

      if (!res.ok) {
        if (res.status === 409) {
          setRetryError("This repository is already being indexed.");
        } else if (res.status === 429) {
          const body = (await res.json().catch(() => null)) as {
            error?: { details?: { retryAfterSeconds?: number } };
          } | null;
          const retryAfterSeconds = body?.error?.details?.retryAfterSeconds;
          setRetryError(
            typeof retryAfterSeconds === "number"
              ? `Too many index requests — try again in ${Math.ceil(retryAfterSeconds / 60).toString()} min.`
              : "Too many index requests for this repository — try again later.",
          );
        } else {
          const body = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          setRetryError(
            body?.error?.message ??
              `Could not start indexing (${res.status.toString()}).`,
          );
        }
        return;
      }

      router.refresh();
    } catch {
      setRetryError(
        "Could not reach the API. Check that it is running, then try again.",
      );
    } finally {
      setRetryPending(false);
    }
  }

  const status = data.status;
  const caption = STATUS_CAPTIONS[status] ?? status;

  if (status === "FAILED") {
    const errorInfo =
      ERROR_MESSAGES[errorCodeOf(data.error)] ?? DEFAULT_ERROR_INFO;
    return (
      <div className="flex flex-col gap-2">
        <Badge variant="destructive">{caption}</Badge>
        <p className="text-xs text-muted-foreground">{errorInfo.message}</p>
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRetry}
            disabled={retryPending}
          >
            {retryPending
              ? "Retrying…"
              : errorInfo.action === "reconnect"
                ? "Reconnect"
                : "Retry"}
          </Button>
        </div>
        {retryError && (
          <p role="alert" className="text-xs text-destructive">
            {retryError}
          </p>
        )}
      </div>
    );
  }

  if (status === "INDEXING" || status === "UPDATING") {
    return (
      <div className="flex flex-col gap-2">
        <Badge variant="outline">{caption}</Badge>
        <Progress value={data.progressPercent} aria-label={caption} />
        <p className="text-xs text-muted-foreground">
          {data.currentStep ?? "working"} — {data.filesProcessed}/
          {data.filesTotal || "…"} files
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Badge variant="outline">{caption}</Badge>
      {isError && (
        <p className="text-xs text-muted-foreground">
          Could not refresh — showing the last known status.
        </p>
      )}
    </div>
  );
}
