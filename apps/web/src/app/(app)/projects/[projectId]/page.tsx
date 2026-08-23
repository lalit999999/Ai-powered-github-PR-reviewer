import Link from "next/link";
import { notFound } from "next/navigation";
import { DeleteProjectButton } from "@/components/projects/delete-project-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getProjectDetail } from "@/lib/api";

/**
 * `/projects/[projectId]` — the detail shell (phase-01 §3/§18).
 *
 * The route param is resolved **server-side, through the API**, which runs
 * `requireTenantAccess` — so someone else's project id in the URL produces a 404 page,
 * not a rendered project (plan.md §34.2: "route params are validated server-side; no
 * client-side-only checks").
 *
 * `repositories` is always empty until Phase 02; the empty state is rendered rather
 * than hidden, because that is the real state of the system.
 */
export default async function ProjectDetailPage({ params }: PageProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  const detail = await getProjectDetail(projectId);

  // The API answers 404 for "not yours" and "does not exist" alike, deliberately
  // (phase-01 §12) — so this page cannot, and should not, tell them apart either.
  if (!detail) {
    notFound();
  }

  const { project, repositories } = detail;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10">
      <Link href="/projects" className="text-sm text-muted-foreground hover:text-foreground">
        ← All projects
      </Link>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {project.slug} · created {new Date(project.createdAt).toLocaleString()}
          </p>
        </div>
        <DeleteProjectButton projectId={project.id} />
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Repositories</CardTitle>
          <CardDescription>
            {repositories.length === 0
              ? "None connected. Connecting a GitHub repository arrives in Phase 02."
              : `${repositories.length} connected.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          This project has no repositories, indexing, or reviews yet — those are later phases.
        </CardContent>
      </Card>
    </div>
  );
}
