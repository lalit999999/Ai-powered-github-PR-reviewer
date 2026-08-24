import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getServerSession, listProjects } from "@/lib/api";

/**
 * `/dashboard` — the shell a user lands on after signing in (phase-01 §15). plan.md
 * §29.1 gives it a cross-project overview of reviews and usage; none of that data
 * exists before Phase 03, so this shows the one real fact it has (how many projects
 * exist) and links onward. Deliberately not filled with placeholder widgets for
 * numbers that cannot be computed yet.
 */
export default async function DashboardPage() {
  const [session, projects] = await Promise.all([getServerSession(), listProjects()]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">
        Signed in as {session?.user?.githubLogin ?? session?.user?.name ?? "your GitHub account"}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Repositories, indexing, and pull-request reviews arrive in later phases.
      </p>

      <Card className="mt-8 max-w-sm">
        <CardHeader>
          <CardTitle>Projects</CardTitle>
          <CardDescription>
            {projects.length === 0
              ? "No projects yet."
              : `${projects.length} project${projects.length === 1 ? "" : "s"}.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/projects" className="text-sm underline underline-offset-4">
            Manage projects
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
