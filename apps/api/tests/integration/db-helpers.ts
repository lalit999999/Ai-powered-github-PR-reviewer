import { prisma } from "@repo/db";

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "WebhookEvent", "PullRequest", "IndexJob", "RepositoryFile", "Repository", "Session", "Account", "VerificationToken", "GithubInstallation", "Project", "User" RESTART IDENTITY CASCADE;',
  );
}
