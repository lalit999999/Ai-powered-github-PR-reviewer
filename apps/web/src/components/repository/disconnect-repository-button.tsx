"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { API_URL } from "@/lib/api-url";

/**
 * Exercises `DELETE /api/repositories/:id`, following `delete-project-button.tsx`'s
 * pattern exactly: a direct destructive action with a pending state and an inline
 * error, not a modal confirm step — the disconnect is a soft transition the user can
 * reverse by reconnecting (phase-02 §11), so the extra friction of a confirm dialog
 * was not judged worth it for the project delete either.
 */
export function DisconnectRepositoryButton({ repositoryId }: { repositoryId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDisconnect() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/repositories/${encodeURIComponent(repositoryId)}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? `Could not disconnect repository (${res.status})`);
        setPending(false);
        return;
      }

      router.refresh();
    } catch {
      setError("Could not reach the API. Check that it is running, then try again.");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={pending}>
        {pending ? "Disconnecting…" : "Disconnect"}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
