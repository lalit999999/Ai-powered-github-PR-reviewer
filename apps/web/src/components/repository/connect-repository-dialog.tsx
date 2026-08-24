"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { API_URL } from "@/lib/api-url";
import type { Installation } from "@/lib/api";

/**
 * `ConnectRepositoryDialog` — sub-task 3.6, following `create-project-dialog.tsx`
 * exactly for the parts that generalize (the error path, `credentials: "include"`,
 * `router.refresh()` instead of local list state) and adding what a repository connect
 * needs on top: an installation selector, a searchable picker, a URL-paste
 * alternative, and per-status-code error treatment.
 *
 * `installations` is passed down from the server-rendered project page — the SAME data
 * `InstallationsPanel` renders — rather than fetched again here, so opening this dialog
 * never disagrees with what the page already shows about which installations exist.
 */

interface PickerRepo {
  githubRepoId: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
}

interface ConnectApiError {
  status: number;
  message: string;
  /** `ConflictError`'s `details.repositoryId` (phase-02 repository-validation.service) —
   * present only on a 409, and only what makes the "already connected" message
   * actionable: a same-page anchor to the existing repository card. */
  repositoryId?: string;
}

const DEBOUNCE_MS = 300;
const INSTALLATION_SETTINGS_URL = "https://github.com/settings/installations";

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function ConnectRepositoryDialog({
  projectId,
  installations,
}: {
  projectId: string;
  installations: Installation[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"search" | "url">("search");
  const [installationId, setInstallationId] = useState(installations[0]?.installationId ?? "");
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS);

  // `queryResult` is written ONLY from inside the fetch's async callbacks below, never
  // synchronously at the top of the effect (react-hooks/set-state-in-effect — a
  // synchronous setState in an effect body risks a cascading extra render). "Loading"
  // is therefore a derived comparison, not its own piece of state: true whenever the
  // last-resolved result's key doesn't match what installationId/debouncedQuery
  // currently ask for, including before the very first fetch has resolved.
  const [queryResult, setQueryResult] = useState<
    { key: string; status: "success"; repos: PickerRepo[] } | { key: string; status: "error"; message: string } | null
  >(null);
  const currentQueryKey = `${installationId}::${debouncedQuery}`;
  const reposLoading = queryResult?.key !== currentQueryKey;
  const repos = queryResult?.key === currentQueryKey && queryResult.status === "success" ? queryResult.repos : null;
  const reposError = queryResult?.key === currentQueryKey && queryResult.status === "error" ? queryResult.message : null;

  const [selectedRepo, setSelectedRepo] = useState<PickerRepo | null>(null);
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ConnectApiError | null>(null);

  const disabled = installations.length === 0;

  function resetState() {
    setMode("search");
    setQuery("");
    setQueryResult(null);
    setSelectedRepo(null);
    setUrl("");
    setError(null);
    setPending(false);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) resetState();
  }

  // The picker's search — server-side filtered (§13: a large installation must not ship
  // every private repository name to the browser to be filtered there). Every setState
  // here happens inside the fetch's own async callbacks, never synchronously in the
  // effect body — see queryResult's declaration above for why.
  useEffect(() => {
    if (!open || mode !== "search" || !installationId) return;

    const key = `${installationId}::${debouncedQuery}`;
    const controller = new AbortController();

    fetch(`${API_URL}/api/github/installations/${installationId}/repos?q=${encodeURIComponent(debouncedQuery)}`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(body?.error?.message ?? `Could not load repositories (${res.status})`);
        }
        return (await res.json()) as { repos: PickerRepo[] };
      })
      .then((body) => setQueryResult({ key, status: "success", repos: body.repos }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : "Could not load repositories";
        setQueryResult({ key, status: "error", message });
      });

    return () => controller.abort();
  }, [open, mode, installationId, debouncedQuery]);

  function handleInstallationChange(next: string) {
    setInstallationId(next);
    setQueryResult(null);
    setSelectedRepo(null);
  }

  async function handleConnect() {
    setPending(true);
    setError(null);

    const body = mode === "url" ? { repoUrl: url.trim() } : { githubRepoId: selectedRepo?.githubRepoId };

    try {
      const res = await fetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}/repositories`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const responseBody = (await res.json().catch(() => null)) as {
          error?: { message?: string; details?: { repositoryId?: string } };
        } | null;
        setError({
          status: res.status,
          message: responseBody?.error?.message ?? `Could not connect that repository (${res.status})`,
          repositoryId: responseBody?.error?.details?.repositoryId,
        });
        setPending(false);
        return;
      }

      setPending(false);
      handleOpenChange(false);
      router.refresh();
    } catch {
      setError({ status: 0, message: "Could not reach the API. Check that it is running, then try again." });
      setPending(false);
    }
  }

  const canSubmit = mode === "url" ? url.trim().length > 0 : selectedRepo !== null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button disabled={disabled} title={disabled ? "Install the GitHub App first" : undefined} />
        }
      >
        Connect repository
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect a repository</DialogTitle>
          <DialogDescription>Search a GitHub App installation, or paste a repository URL.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {installations.length > 1 && mode === "search" && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="installation-select">Installation</Label>
              <NativeSelect
                id="installation-select"
                value={installationId}
                onChange={(event) => handleInstallationChange(event.target.value)}
              >
                {installations.map((installation) => (
                  <NativeSelectOption key={installation.id} value={installation.installationId}>
                    {installation.accountLogin} ({installation.accountType})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}

          <Tabs value={mode} onValueChange={(value) => setMode(value as "search" | "url")}>
            <TabsList>
              <TabsTrigger value="search">Search</TabsTrigger>
              <TabsTrigger value="url">Paste URL</TabsTrigger>
            </TabsList>

            <TabsContent value="search" className="mt-3">
              <Command shouldFilter={false} className="border">
                <CommandInput placeholder="Search repositories…" value={query} onValueChange={setQuery} />
                <CommandList>
                  {reposLoading && (
                    <div className="py-6 text-center text-sm text-muted-foreground">Searching…</div>
                  )}
                  {!reposLoading && reposError && (
                    <div className="py-6 text-center text-sm text-destructive">{reposError}</div>
                  )}
                  {!reposLoading && !reposError && repos !== null && repos.length === 0 && (
                    <CommandEmpty>
                      {debouncedQuery
                        ? "No repositories match your search."
                        : "This installation has access to no repositories — check its GitHub App settings."}
                    </CommandEmpty>
                  )}
                  {!reposLoading && !reposError && repos !== null && repos.length > 0 && (
                    <CommandGroup>
                      {repos.map((repo) => (
                        <CommandItem
                          key={repo.githubRepoId}
                          value={repo.githubRepoId}
                          data-checked={selectedRepo?.githubRepoId === repo.githubRepoId}
                          onSelect={() => setSelectedRepo(repo)}
                        >
                          <span className="truncate">{repo.fullName}</span>
                          <Badge variant={repo.isPrivate ? "secondary" : "outline"} className="ml-auto shrink-0">
                            {repo.isPrivate ? "Private" : "Public"}
                          </Badge>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                </CommandList>
              </Command>
              {selectedRepo && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Selected: <span className="font-medium text-foreground">{selectedRepo.fullName}</span>
                </p>
              )}
            </TabsContent>

            <TabsContent value="url" className="mt-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="repo-url">Repository URL</Label>
                <Input
                  id="repo-url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://github.com/owner/repo"
                  autoFocus
                />
              </div>
            </TabsContent>
          </Tabs>

          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>
                {error.message}
                {error.status === 403 && (
                  <>
                    {" — "}
                    <a href={INSTALLATION_SETTINGS_URL} target="_blank" rel="noopener noreferrer" className="underline">
                      check your installation settings
                    </a>
                  </>
                )}
                {error.status === 409 && error.repositoryId && (
                  <>
                    {" — "}
                    <a href={`#repository-${error.repositoryId}`} className="underline" onClick={() => handleOpenChange(false)}>
                      view it below
                    </a>
                  </>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button onClick={handleConnect} disabled={pending || !canSubmit}>
            {pending ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
