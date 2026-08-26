import { prisma } from "@repo/db";
import { expect } from "vitest";
import type { GithubRepositoryMetadata } from "@repo/github";

/**
 * Shared setup for the repository-connect integration suite (`repositories.test.ts`)
 * and its cross-tenant extension. Mirrors `auth-helpers.ts`'s role: real Prisma rows for
 * the parts of the flow that are not what the test is actually exercising.
 *
 * `GithubInstallation` rows are seeded directly rather than through
 * `GET /api/github/installations` (the sync route) on purpose. That route's own job —
 * turning a `listUserInstallations` GitHub call into stored rows — is not what this
 * suite tests; `repository.service.connectRepository` only ever reads the *stored* rows
 * (`installationRepository.listInstallationsForUser`), so seeding them directly keeps
 * this suite decoupled from the sync flow's own correctness, the same way
 * `seedSignedInUser` seeds a `Session` row directly instead of running the OAuth dance.
 */

let installationSeq = 0;

export interface SeededInstallation {
  id: string;
  installationId: bigint;
  accountLogin: string;
}

export async function seedInstallation(
  userId: string,
  overrides: { accountLogin?: string; accountType?: string; installationId?: bigint } = {},
): Promise<SeededInstallation> {
  installationSeq += 1;
  const row = await prisma.githubInstallation.create({
    data: {
      installationId: overrides.installationId ?? BigInt(60_000_000 + installationSeq),
      accountLogin: overrides.accountLogin ?? "octocat",
      accountType: overrides.accountType ?? "User",
      userId,
    },
  });
  return { id: row.id, installationId: row.installationId, accountLogin: row.accountLogin };
}

let repoIdSeq = 0;

/** A realistic `GithubRepositoryMetadata` — what `repositoryGithub.getRepository`'s
 * mocked result carries in `{ ok: true, repository: ... }`. One counter-derived id per
 * call by default so tests that connect several repositories never collide by accident. */
export function githubRepoMetadata(overrides: Partial<GithubRepositoryMetadata> = {}): GithubRepositoryMetadata {
  repoIdSeq += 1;
  const owner = overrides.owner ?? "octocat";
  const name = overrides.name ?? `hello-world-${repoIdSeq}`;
  return {
    githubRepoId: overrides.githubRepoId ?? BigInt(900_000_000 + repoIdSeq),
    owner,
    name,
    fullName: overrides.fullName ?? `${owner}/${name}`,
    defaultBranch: overrides.defaultBranch === undefined ? "main" : overrides.defaultBranch,
    isPrivate: overrides.isPrivate ?? false,
    htmlUrl: overrides.htmlUrl ?? `https://github.com/${owner}/${name}`,
    sizeKib: overrides.sizeKib ?? 108,
    archived: overrides.archived ?? false,
    disabled: overrides.disabled ?? false,
  };
}

/** Real GitHub token prefixes — see packages/github/tests/fixtures/github/README.md for why a fixture
 * would never legitimately match this. Used to prove no table holds a minted token. */
const TOKEN_SHAPE = /gh[aoprsu]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{80,}/;

/** Scans every `Repository` and `GithubInstallation` column value for anything shaped
 * like a real GitHub token. Meaningful even though this suite's GitHub layer is mocked
 * and never mints a real token: it is a structural assertion that the schema itself has
 * nowhere a token could be written, not merely that this test run didn't write one. */
export async function assertNoTokenPersisted(): Promise<void> {
  const [repositories, installations] = await Promise.all([
    prisma.repository.findMany(),
    prisma.githubInstallation.findMany(),
  ]);
  const serialized = JSON.stringify([repositories, installations], (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  expect(serialized).not.toMatch(TOKEN_SHAPE);
}
