import Link from "next/link";
import { notFound } from "next/navigation";
import { DeleteProjectButton } from "@/components/projects/delete-project-button";
import { ConnectRepositoryDialog } from "@/components/repository/connect-repository-dialog";
import { InstallationsPanel } from "@/components/repository/installations-panel";
import { RepositoryCard } from "@/components/repository/repository-card";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getProjectDetail, listInstallations } from "@/lib/api";

/**
 * `/projects/[projectId]` — the detail shell (phase-01 §3/§18, phase-02 §3/§18).
 *
 * The route param is resolved **server-side, through the API**, which runs
 * `requireTenantAccess` — so someone else's project id in the URL produces a 404 page,
 * not a rendered project (plan.md §34.2: "route params are validated server-side; no
 * client-side-only checks").
 *
 * Fetched in parallel: the project detail and the installations sync are independent
 * reads, and there is no reason to serialize them behind one another.
 */
export default async function ProjectDetailPage({ params }: PageProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  const [detail, installationsResult] = await Promise.all([getProjectDetail(projectId), listInstallations()]);

  // The API answers 404 for "not yours" and "does not exist" alike, deliberately
  // (phase-01 §12) — so this page cannot, and should not, tell them apart either.
  if (!detail) {
    notFound();
  }

  const { project, repositories } = detail;
  const installations = installationsResult.ok ? installationsResult.installations : [];

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

      <div className="mt-8">
        <InstallationsPanel
          installations={installationsResult.ok ? installationsResult.installations : []}
          installUrl={installationsResult.ok ? installationsResult.installUrl : ""}
          unavailable={!installationsResult.ok}
        />
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Repositories</CardTitle>
          <CardDescription>
            {repositories.length === 0 ? "None connected yet." : `${repositories.length} connected.`}
          </CardDescription>
          <CardAction>
            <ConnectRepositoryDialog projectId={project.id} installations={installations} />
          </CardAction>
        </CardHeader>
        <CardContent>
          {repositories.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {installations.length === 0
                ? "Install the GitHub App above, then connect a repository."
                : "Connect a repository to get started — indexing and reviews are later phases."}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {repositories.map((repository) => (
                <RepositoryCard key={repository.id} repository={repository} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
