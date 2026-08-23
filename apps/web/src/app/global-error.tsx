"use client";

/**
 * Catches errors thrown by the root layout itself, which the segment-level
 * error.tsx cannot (phase-00 §3). Must render its own <html>/<body>: this file
 * *replaces* the root layout when active, so it gets none of the app's fonts,
 * global styles, or theme class — hence the inline styles and the neutral palette
 * that reads acceptably in both light and dark.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          display: "flex",
          minHeight: "100vh",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
          padding: "4rem 1rem",
        }}
      >
        <h2 style={{ fontSize: "1.25rem", fontWeight: 600 }}>
          Something went wrong
        </h2>
        {error.digest ? (
          <p style={{ fontSize: "0.875rem", opacity: 0.7 }}>
            Reference: <code>{error.digest}</code>
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => retry()}
          style={{
            cursor: "pointer",
            borderRadius: "9999px",
            border: "1px solid currentColor",
            background: "transparent",
            color: "inherit",
            padding: "0.5rem 1.25rem",
            font: "inherit",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
