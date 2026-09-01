import { prisma } from "@repo/db";

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "CodeDependency", "CodeSymbol", "PatchBlob", "ReviewJob", "PullRequestFile", "Review", "WebhookEvent", "PullRequest", "IndexJob", "RepositoryFile", "Repository", "Session", "Account", "VerificationToken", "GithubInstallation", "Project", "User" RESTART IDENTITY CASCADE;',
  );
}
