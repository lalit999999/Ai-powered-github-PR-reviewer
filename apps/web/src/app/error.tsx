"use client";

import { Button } from "@/components/ui/button";

/**
 * Route-segment error boundary (phase-00 §3). `retry` is the stable prop in the
 * installed Next.js 16.3.2 (`reset` is the older API — see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md,
 * "Version History": retry became stable in v16.3.0).
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-16 text-center">
      <h2 className="text-xl font-semibold">Something went wrong</h2>
      {/* digest is the only safe identifier to surface — it correlates to the
          server-side log line without leaking the error's contents. */}
      {error.digest ? (
        <p className="text-sm text-muted-foreground">
          Reference: <code className="font-mono">{error.digest}</code>
        </p>
      ) : null}
      <Button onClick={() => retry()}>Try again</Button>
    </div>
  );
}
