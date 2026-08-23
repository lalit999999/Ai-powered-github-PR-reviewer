"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
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
import { API_URL } from "@/lib/api-url";

/**
 * `ConnectRepositoryDialog`'s smaller sibling from plan.md §29.2's client-island list —
 * a form with validation feedback, which is exactly the case that has to be a client
 * component.
 *
 * The interesting part is the error path: the API answers 400 for a bad name and 409
 * when a slug is somehow still taken after its one retry (phase-01 §12), and both carry
 * a message in the standard envelope. Showing that message is how "That name is taken,
 * try another" reaches the user instead of a generic failure.
 *
 * `router.refresh()` re-runs the server component that listed the projects, rather than
 * pushing the new project into local state — the list is server-rendered, so refetching
 * is what keeps it truthful.
 */
export function CreateProjectDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setName("");
      setError(null);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/api/projects`, {
        method: "POST",
        // Sends the session cookie to the API's origin.
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? `Could not create project (${res.status})`);
        setPending(false);
        return;
      }

      setPending(false);
      handleOpenChange(false);
      router.refresh();
    } catch {
      setError("Could not reach the API. Check that it is running, then try again.");
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button />}>New project</DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>A project groups the repositories you want reviewed.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Test Project"
              maxLength={100}
              autoFocus
              required
            />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending || name.trim().length === 0}>
              {pending ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
