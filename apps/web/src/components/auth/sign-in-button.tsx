"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { API_URL } from "@/lib/api-url";

/**
 * Starts the GitHub OAuth flow against `apps/api`'s Auth.js mount.
 *
 * Auth.js requires sign-in to be a **POST carrying a CSRF token** — a plain link is
 * rejected — so this fetches the token (which also sets the paired csrf cookie), then
 * submits a real form so the browser follows the 302 to GitHub. Doing it as a form
 * submit rather than `fetch` matters: `fetch` would follow the redirect itself and
 * leave the user on this page.
 *
 * The cookies travel cross-origin because `apps/web` and `apps/api` are same-*site*
 * (ports are not part of a site, and in deployed environments they are subdomains of
 * one registrable domain). `sameSite=lax` would otherwise drop them — see
 * docs/deployment.md.
 */
export function SignInButton({ callbackUrl }: { callbackUrl: string }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function startSignIn() {
    setPending(true);
    setFailed(false);
    try {
      const res = await fetch(`${API_URL}/api/auth/csrf`, { credentials: "include" });
      if (!res.ok) throw new Error(`csrf ${res.status}`);
      const { csrfToken } = (await res.json()) as { csrfToken: string };

      const form = document.createElement("form");
      form.method = "POST";
      form.action = `${API_URL}/api/auth/signin/github`;
      form.style.display = "none";

      for (const [name, value] of Object.entries({ csrfToken, callbackUrl })) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }

      document.body.appendChild(form);
      form.submit();
    } catch {
      // The API being unreachable is the realistic failure here; show it rather than
      // leaving a button stuck in a pending state.
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button onClick={startSignIn} disabled={pending}>
        {pending ? "Redirecting to GitHub…" : "Sign in with GitHub"}
      </Button>
      {failed && (
        <p className="text-sm text-destructive">
          Could not reach the sign-in service. Check that the API is running, then try again.
        </p>
      )}
    </div>
  );
}
