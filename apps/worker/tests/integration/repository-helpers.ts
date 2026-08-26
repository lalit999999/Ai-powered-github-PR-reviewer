import { prisma } from "@repo/db";

/**
 * Seeds a real `User` → `Project` → `Repository` chain directly through Prisma — this
 * suite tests `repository-index`'s own pipeline, not the connect flow (that is
 * `apps/api`'s `repositories.test.ts`), so there is no reason to drive it through HTTP
 * or a session, matching `repository-helpers.ts` (apps/api)'s own "seed what the test
 * doesn't exercise" convention.
 */

let seq = 0;

export interface SeededRepository {
  id: string;
  projectId: string;
  installationId: bigint;
  owner: string;
  name: string;
  defaultBranch: string;
}

export async function seedRepository(
  overrides: Partial<{
    owner: string;
    name: string;
    defaultBranch: string;
    installationId: bigint;
    indexStatus: "PENDING" | "INDEXING" | "INDEXED" | "FAILED";
    indexedCommitSha: string | null;
  }> = {},
): Promise<SeededRepository> {
  seq += 1;

  const user = await prisma.user.create({
    data: { githubUserId: BigInt(2_000_000 + seq), githubLogin: `fixture-user-${seq.toString()}`, email: `fixture-${seq.toString()}@example.com` },
  });

  const project = await prisma.project.create({
    data: { userId: user.id, name: `Fixture Project ${seq.toString()}`, slug: `fixture-project-${seq.toString()}` },
  });

  const owner = overrides.owner ?? "octocat";
  const name = overrides.name ?? `fixture-repo-${seq.toString()}`;

  const repository = await prisma.repository.create({
    data: {
      projectId: project.id,
      installationId: overrides.installationId ?? BigInt(70_000_000 + seq),
      githubRepoId: BigInt(950_000_000 + seq),
      owner,
      name,
      fullName: `${owner}/${name}`,
      defaultBranch: overrides.defaultBranch ?? "main",
      isPrivate: false,
      htmlUrl: `https://github.com/${owner}/${name}`,
      indexStatus: overrides.indexStatus ?? "PENDING",
      indexedCommitSha: overrides.indexedCommitSha ?? null,
    },
  });

  return {
    id: repository.id,
    projectId: project.id,
    installationId: repository.installationId,
    owner: repository.owner,
    name: repository.name,
    defaultBranch: repository.defaultBranch,
  };
}
