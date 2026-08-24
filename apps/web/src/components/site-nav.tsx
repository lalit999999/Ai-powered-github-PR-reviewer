import Link from "next/link";

/**
 * Navigation placeholder (phase-00 §3). Deliberately not auth-aware — sign-in/out
 * controls and the real product navigation arrive with Phase 01's UI (Prompt 3).
 */
export function SiteNav() {
  return (
    <header className="border-b">
      <nav className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link href="/" className="font-semibold tracking-tight">
          PR Reviewer
        </Link>
      </nav>
    </header>
  );
}
