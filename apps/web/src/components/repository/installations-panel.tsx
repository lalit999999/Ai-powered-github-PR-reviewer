"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import type { Installation } from "@/lib/api";

/**
 * Sub-task 3.5: the "Install GitHub App" entry point and installations list.
 *
 * `installations`/`installUrl`/`unavailable` are fetched **server-side**
 * (`ProjectDetailPage` calls `listInstallations()`), for the same reason every other
 * list on this page is: `cache: "no-store"` and a real session cookie is what keeps
 * this from ever showing one user a stale copy of another's data. "Refresh" therefore
 * does not re-fetch client-side — it calls `router.refresh()`, which re-runs the server
 * component and, with it, the real sync against GitHub (§10). That sync is exactly
 * what a fresh page load already does; this button exists because a user who installed
 * the App in another tab and comes back has no other way to ask for it again.
 *
 * ## TEMPORARY — replaced by webhooks in Phase 06
 *
 * This whole panel exists because Phase 06's `installation`/`installation_repositories`
 * webhook handling doesn't exist yet (phase-02 §10). Once it does, installations update
 * in near-real-time and this poll-on-load-plus-manual-refresh pattern goes away — the
 * list itself does not need to change, only what triggers it to update.
 */
export function InstallationsPanel({
  installations,
  installUrl,
  unavailable = false,
}: {
  installations: Installation[];
  installUrl: string;
  unavailable?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleRefresh() {
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub installations</CardTitle>
        <CardDescription>
          The GitHub App installations available to connect a repository from.
        </CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={pending}
          >
            {pending ? "Refreshing…" : "Refresh"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {unavailable ? (
          <Alert variant="destructive">
            <AlertDescription>
              Your GitHub sign-in needs to be refreshed — sign out and back in.
            </AlertDescription>
          </Alert>
        ) : installations.length === 0 ? (
          <Empty className="border border-dashed py-8">
            <EmptyHeader>
              <EmptyTitle>No installations yet</EmptyTitle>
              <EmptyDescription>
                Install the GitHub App to get started.
              </EmptyDescription>
            </EmptyHeader>
            <Button
              render={
                <a
                  href={installUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              Install GitHub App
            </Button>
          </Empty>
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-2">
              {installations.map((installation) => (
                <li
                  key={installation.id}
                  className="flex items-center justify-between gap-3 rounded-2xl border px-4 py-2.5 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {installation.accountLogin}
                    </span>
                    <Badge variant="secondary">
                      {installation.accountType}
                    </Badge>
                  </div>
                  {installation.suspended && (
                    <Badge variant="destructive">Suspended</Badge>
                  )}
                </li>
              ))}
            </ul>
            <a
              href={installUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="self-start text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Add another account or repository →
            </a>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
