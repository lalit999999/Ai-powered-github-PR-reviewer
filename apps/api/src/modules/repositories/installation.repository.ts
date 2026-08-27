import { prisma } from "@repo/db";
import type { InstallationRecord } from "./repository.types.js";

/**
 * Prisma access for `GithubInstallation` and for the one `Account` column this phase
 * reads. A sibling of `repository.repository.ts` rather than more functions inside it:
 * an installation is a *different aggregate* — it belongs to a user, not to a project,
 * and its lifecycle is owned by GitHub's install flow (and, from Phase 06, by webhooks)
 * rather than by anything in the repositories module.
 *
 * Rule B: only `*.repository.ts` files may import `@repo/db`'s Prisma singleton.
 */

const INSTALLATION_SELECT = {
  id: true,
  installationId: true,
  accountLogin: true,
  accountType: true,
  userId: true,
  suspendedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface UpsertInstallationInput {
  installationId: bigint;
  accountLogin: string;
  accountType: string;
  userId: string;
  suspendedAt: Date | null;
}

/**
 * Creates or refreshes a `GithubInstallation` row.
 *
 * **Keyed on the `@unique installationId`**, not on `(userId, installationId)`, because
 * an installation id is GitHub-global: the same id can only ever mean one installation,
 * and two rows for it would be a corruption, not two tenants' data.
 *
 * `userId` is therefore in the `update` block as well as the `create` one. That is
 * deliberate and worth stating: if an org installation is re-synced by a different
 * member of that org, the row re-attributes to whoever most recently proved — through
 * their own OAuth token, via `GET /user/installations` — that they can see it. Both
 * users legitimately can; §7's ownership check asks "may this caller use this
 * installation", and a stale attribution would answer no for a person GitHub says yes
 * for. Phase 06's webhook-driven sync is where this becomes a real multi-user
 * question rather than a single-user sync artifact.
 */
export async function upsertInstallation(
  input: UpsertInstallationInput,
): Promise<InstallationRecord> {
  return prisma.githubInstallation.upsert({
    where: { installationId: input.installationId },
    create: {
      installationId: input.installationId,
      accountLogin: input.accountLogin,
      accountType: input.accountType,
      userId: input.userId,
      suspendedAt: input.suspendedAt,
    },
    update: {
      accountLogin: input.accountLogin,
      accountType: input.accountType,
      userId: input.userId,
      suspendedAt: input.suspendedAt,
    },
    select: INSTALLATION_SELECT,
  });
}

/** Every installation attributed to this user. Owner-scoped in the `where`. */
export async function listInstallationsForUser(
  userId: string,
): Promise<InstallationRecord[]> {
  return prisma.githubInstallation.findMany({
    where: { userId },
    select: INSTALLATION_SELECT,
    orderBy: [{ accountLogin: "asc" }],
  });
}

/**
 * The ownership check behind §13's "access to `GET /installation/repositories` is
 * scoped to installations the requesting user owns, cross-checked via
 * `GithubInstallation.userId`, **never trusted from client input**".
 *
 * Both halves of the key are in the `where`, so a `null` result means "not this user's"
 * and "no such installation" alike — the caller decides what to say (the installations
 * endpoint answers 403 for both; see github.controller.ts for why that is the right
 * answer here and not elsewhere).
 */
export async function findInstallationForUser(
  userId: string,
  installationId: bigint,
): Promise<InstallationRecord | null> {
  return prisma.githubInstallation.findFirst({
    where: { userId, installationId },
    select: INSTALLATION_SELECT,
  });
}

/**
 * The signed-in user's GitHub **OAuth** access token, as stored on the `Account` row by
 * the Auth.js adapter at sign-in.
 *
 * This is read here, in the repository layer, precisely so no service ever reaches for
 * `prisma.account` itself (Rule B) — and so there is exactly one place in the codebase
 * that knows a user's GitHub token is a column rather than something the session
 * carries.
 *
 * Returns `null` when the user has no GitHub account linked, or when the adapter stored
 * no token. `provider: "github"` is pinned rather than taking whatever account exists:
 * this token is about to be sent to github.com, and sending a different provider's
 * token there would be a credential leak, not a failed request.
 */
export async function findGithubAccessToken(
  userId: string,
): Promise<string | null> {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "github" },
    select: { access_token: true },
  });
  return account?.access_token ?? null;
}
