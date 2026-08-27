import { prisma } from "@repo/db";

/** Mirrors `apps/api/tests/integration/db-helpers.ts`'s table list exactly — the same
 * full schema either deployable's Testcontainers instance provisions via `prisma
 * migrate deploy`, even though this suite only ever writes a subset of it. */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
<<<<<<< HEAD
    'TRUNCATE TABLE "CodeDependency", "CodeSymbol", "IndexJob", "RepositoryFile", "Repository", "Session", "Account", "VerificationToken", "GithubInstallation", "Project", "User" RESTART IDENTITY CASCADE;',
=======
    'TRUNCATE TABLE "WebhookEvent", "PullRequest", "IndexJob", "RepositoryFile", "Repository", "Session", "Account", "VerificationToken", "GithubInstallation", "Project", "User" RESTART IDENTITY CASCADE;',
>>>>>>> main
  );
}
