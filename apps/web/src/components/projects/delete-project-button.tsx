"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { API_URL } from "@/lib/api-url";

/**
 * Exercises `DELETE /api/projects/:id` from the UI. Present because the phase's UI
 * exists to drive all four routes (§3) — not as a step toward a settings surface.
 *
 * The delete is a soft delete and the API is idempotent about it (phase-01 §4/§11), so
 * a double click is harmless; the navigation away is what actually needs guarding, and
 * `pending` does that.
 */
export function DeleteProjectButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? `Could not delete project (${res.status})`);
        setPending(false);
        return;
      }

      router.push("/projects");
      router.refresh();
    } catch {
      setError("Could not reach the API. Check that it is running, then try again.");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button variant="outline" size="sm" onClick={handleDelete} disabled={pending}>
        {pending ? "Deleting…" : "Delete project"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
