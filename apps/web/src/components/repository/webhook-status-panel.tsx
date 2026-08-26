"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { API_URL } from "@/lib/api-url";
import type { WebhookDelivery } from "@/lib/api";

/**
 * `POST /api/repositories/:id/webhook-test`'s panel (phase-06 §3/§7/§14) — copies
 * `index-status-poller.tsx`'s structure (read that file first) but makes a different
 * class of decision for its one structural difference: **there is no terminal state
 * here.** Deliveries arrive indefinitely for as long as the repository is connected, so
 * the "stop polling once INDEXED/FAILED" pattern that component uses has nothing to
 * settle into.
 *
 * ## Polling strategy — fetch on expand, refresh on demand, never a background interval
 *
 * `IndexStatusPoller` polls every 2s until a terminal state is reached, because the
 * thing it watches finishes. This panel's data source never finishes, so an equivalent
 * "poll forever while mounted" would mean every open repository card silently re-hits
 * this endpoint on an interval for as long as the page stays open, on a dashboard that
 * can show many cards at once — exactly the failure mode `IndexStatusPoller`'s own header
 * comment calls out avoiding via its terminal-state stop.
 *
 * The decision here: `enabled: open`, no `refetchInterval` at all. The query only runs
 * when the collapsible is actually expanded — a panel nobody opened costs nothing — and
 * afterward the user drives every subsequent fetch through the explicit refresh button.
 * `@tanstack/react-query@5.101.4` (the installed version, verified against its own
 * `package.json` rather than assumed) already pauses `refetchOnWindowFocus` behavior
 * correctly for a hidden tab by default, so there is no background-tab case to special
 * case here either.
 *
 * ## The empty state is the point
 *
 * §14's manual verification exists specifically to catch a misconfigured GitHub App
 * webhook URL, and "No deliveries yet" is what a user sees when that misconfiguration is
 * the problem. A bare "None" would not tell them what to check next, so the empty state
 * names the actionable thing.
 *
 * ## The refresh button's label is honest, not "Send test webhook"
 *
 * §3 calls this a "test webhook" affordance; §7 clarifies the route reads existing rows
 * and sends nothing. A button labeled "Send test webhook" would lie about what happens
 * when it's clicked — worse than no button at all.
 */

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  DISPATCHED: "default",
  IGNORED: "secondary",
  PENDING: "outline",
  FAILED: "destructive",
};

function formatRelativeTime(iso: string): string {
  const deltaSeconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (deltaSeconds < 60) return "just now";
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

async function fetchRecentDeliveries(repositoryId: string): Promise<WebhookDelivery[]> {
  const res = await fetch(`${API_URL}/api/repositories/${encodeURIComponent(repositoryId)}/webhook-test`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Could not load webhook deliveries (${res.status})`);
  }
  const body = (await res.json()) as { recentDeliveries: WebhookDelivery[] };
  return body.recentDeliveries;
}

export function WebhookStatusPanel({ repositoryId }: { repositoryId: string }) {
  const [open, setOpen] = useState(false);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["webhook-deliveries", repositoryId],
    queryFn: () => fetchRecentDeliveries(repositoryId),
    enabled: open,
    retry: 1,
  });

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-2">
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
        {open ? "Hide webhook activity" : "Show webhook activity"}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 pt-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {data && data.length > 0
              ? `Last delivery ${formatRelativeTime(data[0]!.createdAt)}`
              : "Recent GitHub webhook deliveries for this repository"}
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? "Checking…" : "Check for recent deliveries"}
          </Button>
        </div>

        {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}

        {isError && (
          <p role="alert" className="text-xs text-destructive">
            Could not load webhook deliveries — try again.
          </p>
        )}

        {data && data.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No deliveries yet. If you just connected this repository, confirm the GitHub App&rsquo;s
            webhook URL points at this deployment and that something has happened on it since
            (a push, an opened pull request).
          </p>
        )}

        {data && data.length > 0 && (
          <ul className="flex flex-col gap-1">
            {data.map((delivery) => (
              <li key={delivery.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">
                  {delivery.eventType}
                  {delivery.action ? `.${delivery.action}` : ""}
                </span>
                <span className="flex items-center gap-2">
                  <Badge variant={STATUS_VARIANTS[delivery.status] ?? "outline"}>{delivery.status}</Badge>
                  <span className="text-muted-foreground">{formatRelativeTime(delivery.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
