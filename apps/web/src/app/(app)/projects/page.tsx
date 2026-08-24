import Link from "next/link";
import { CreateProjectDialog } from "@/components/projects/create-project-dialog";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listProjects } from "@/lib/api";

/**
 * `/projects` — list plus create dialog (phase-01 §3). A server component: the list is
 * fetched per request with the caller's cookie, so the API's own tenancy scoping is
 * what decides what appears here. There is no client-side filtering of someone else's
 * projects, because none are ever sent.
 */
export default async function ProjectsPage() {
  const projects = await listProjects();

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A project is the tenancy root — repositories connect into one in Phase 02.
          </p>
        </div>
        <CreateProjectDialog />
      </div>

      {projects.length === 0 ? (
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>No projects yet</CardTitle>
            <CardDescription>Create one to get started.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <ul className="mt-8 flex flex-col gap-3">
          {projects.map((project) => (
            <li key={project.id}>
              <Link href={`/projects/${project.id}`} className="block">
                <Card className="transition-colors hover:bg-accent/40">
                  <CardHeader>
                    <CardTitle>{project.name}</CardTitle>
                    <CardDescription>
                      {project.slug} · created {new Date(project.createdAt).toLocaleDateString()}
                    </CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
