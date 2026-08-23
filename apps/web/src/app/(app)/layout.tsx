import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { getServerSession } from "@/lib/api";

/**
 * Authenticated product surface (plan.md §44) — /dashboard, /projects, …
 *
 * **This is the authoritative protected-route check** (phase-01 §3/§17 step 10). It
 * runs on the server and resolves the session against the API/database, so an expired
 * or forged cookie is rejected here even though `src/middleware.ts` let it through:
 * the middleware only checks that *a* cookie exists, which is all the Edge runtime can
 * cheaply do. There is no client-side-only check anywhere in this path.
 *
 * `force-dynamic` because the check must happen per request — and because it keeps
 * `next build` from attempting to prerender these pages against an API that isn't
 * running at build time.
 */
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession();

  if (!session?.user) {
    redirect("/signin");
  }

  return (
    <>
      <header className="border-b">
        <nav className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-4">
            <Link href="/dashboard" className="font-semibold tracking-tight">
              PR Reviewer
            </Link>
            <Link href="/projects" className="text-sm text-muted-foreground hover:text-foreground">
              Projects
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {session.user.githubLogin ?? session.user.name ?? session.user.email}
            </span>
            <SignOutButton />
          </div>
        </nav>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </>
  );
}
