import { prisma } from "@repo/db";

/** Mirrors `apps/api/tests/integration/db-helpers.ts`'s table list — the same full
 * schema either deployable's Testcontainers instance provisions via `prisma migrate
 * deploy`, even though this suite only ever writes a subset of it. `CodeChunk` needs no
 * entry of its own: it cascades from `Repository`'s own `ON DELETE CASCADE`.
 * `EmbeddingCache` does — it carries no `repositoryId` at all (Phase 05 §6: shared
 * globally across repositories, deliberately), so nothing else in this list ever cascades
 * into it; omitting it here would leak cache rows across otherwise-isolated test runs. */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "CodeDependency", "CodeSymbol", "EmbeddingCache", "WebhookEvent", "PullRequest", "IndexJob", "RepositoryFile", "Repository", "Session", "Account", "VerificationToken", "GithubInstallation", "Project", "User" RESTART IDENTITY CASCADE;',
  );
}
