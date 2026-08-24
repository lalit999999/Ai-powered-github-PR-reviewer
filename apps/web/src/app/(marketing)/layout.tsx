import { SiteNav } from "@/components/site-nav";

/**
 * Public/unauthenticated surface (plan.md §44). A route group, so "(marketing)"
 * never appears in a URL — "/" still resolves to (marketing)/page.tsx.
 */
export default function MarketingLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SiteNav />
      <main className="flex flex-1 flex-col">{children}</main>
    </>
  );
}
