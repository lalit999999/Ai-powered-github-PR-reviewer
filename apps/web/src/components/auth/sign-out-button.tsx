"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { API_URL } from "@/lib/api-url";

/**
 * Signs out through Auth.js, which **deletes the `Session` row** — so the old cookie
 * stops authenticating immediately rather than merely being forgotten by the browser
 * (phase-01 §15; this revocability is the whole reason for database sessions over JWTs,
 * §1/§22).
 *
 * Same CSRF-token-then-form-POST shape as the sign-in button, for the same reason.
 */
export function SignOutButton() {
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/csrf`, { credentials: "include" });
      const { csrfToken } = (await res.json()) as { csrfToken: string };

      const form = document.createElement("form");
      form.method = "POST";
      form.action = `${API_URL}/api/auth/signout`;
      form.style.display = "none";

      for (const [name, value] of Object.entries({
        csrfToken,
        callbackUrl: `${window.location.origin}/`,
      })) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }

      document.body.appendChild(form);
      form.submit();
    } catch {
      setPending(false);
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={signOut} disabled={pending}>
      Sign out
    </Button>
  );
}
