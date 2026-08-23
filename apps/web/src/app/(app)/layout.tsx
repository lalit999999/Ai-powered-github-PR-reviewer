import { SiteNav } from "@/components/site-nav";

/**
 * Authenticated product surface (plan.md §44) — /dashboard, /projects, etc. land
 * here in Prompt 3. Deliberately contains no auth check yet: protected-route
 * enforcement is Phase 01 UI work (phase-01 §3/§17 step 10), explicitly out of
 * scope for this prompt. The group exists now so those pages have a home that
 * already has the right layout/loading/error conventions around it.
 */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SiteNav />
      <main className="flex flex-1 flex-col">{children}</main>
    </>
  );
}
