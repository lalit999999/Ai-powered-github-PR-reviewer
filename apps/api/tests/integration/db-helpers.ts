import { prisma } from "@repo/db";

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
<<<<<<< HEAD
    'TRUNCATE TABLE "CodeDependency", "CodeSymbol", "IndexJob", "RepositoryFile", "Repository", "Session", "Account", "VerificationToken", "GithubInstallation", "Project", "User" RESTART IDENTITY CASCADE;',
=======
    'TRUNCATE TABLE "WebhookEvent", "PullRequest", "IndexJob", "RepositoryFile", "Repository", "Session", "Account", "VerificationToken", "GithubInstallation", "Project", "User" RESTART IDENTITY CASCADE;',
>>>>>>> main
  );
}
