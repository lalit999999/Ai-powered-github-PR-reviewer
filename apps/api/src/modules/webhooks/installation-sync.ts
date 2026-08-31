import { createLogger } from "@repo/observability";
import * as installationRepository from "../repositories/installation.repository.js";
import * as repositoryRepository from "../repositories/repository.repository.js";
import type {
  ParsedInstallationEvent,
  ParsedInstallationRepositoriesEvent,
  ParsedRepositoryEvent,
} from "./webhook.schema.js";

/**
 * `installation`/`installation_repositories`/`repository` sync (phase-06 §2, Prompt 4
 * sub-task 4.2) — the resolution to phase-06 §3's "replacing the polling-based sync
 * fallback Phase 02 used temporarily," **partly achieved, not fully**. Read this file's
 * header before touching `installation.created` below; the limitation is load-bearing,
 * not an oversight.
 *
 * ## The conflict this module does not paper over
 *
 * `GithubInstallation.userId` is a **required** foreign key to `User`. An
 * `installation.created` webhook payload names the GitHub *account* the App was
 * installed on — it contains nothing that identifies which of this product's users is
 * signed in, because installing a GitHub App and signing into this product are two
 * different acts, possibly performed by two different people, or by someone who has
 * never signed in at all. `installation.repository.ts`'s own `upsertInstallation` doc
 * comment already anticipated this ("Phase 06's webhook-driven sync is where this
 * becomes a real multi-user question rather than a single-user sync artifact").
 *
 * **The decision this file implements:** `installation.created` is **update only**. If a
 * `GithubInstallation` row for that `installationId` already exists, its
 * `accountLogin`/`accountType`/`suspendedAt` are refreshed. If it does not exist, this
 * module logs at `info` and does nothing — it never invents a `userId`, never picks an
 * arbitrary owner, and never makes the column nullable to work around the gap.
 *
 * `GET /api/github/installations` (`github.controller.ts`'s `listInstallations`) remains
 * the only path that can create a `GithubInstallation` row, because it is the only path
 * that knows who is signed in (see that file's own updated comment). Webhooks now handle
 * every *staleness* update this file's table lists; the page-load sync's remaining job is
 * narrower and permanent: **attribution**, not a fallback for an endpoint that doesn't
 * exist yet.
 *
 * ## `installation.deleted` — the row is kept, not removed
 *
 * `Repository.installationId`'s own schema comment explains why that column is
 * deliberately *not* a foreign key to `GithubInstallation`: a real FK would cascade-delete
 * `Repository` rows the moment an App is uninstalled, and "losing connection history is
 * worse than the missing referential integrity — `ACCESS_LOST` exists precisely to
 * represent 'installation gone, row kept'." The same argument applies one level up, to
 * the `GithubInstallation` row itself: deleting it on `installation.deleted` would throw
 * away exactly the record ("this installation existed, was owned by this user, connected
 * these repositories") that `ACCESS_LOST` on the `Repository` side is trying to preserve
 * the shadow of. `installation.deleted` therefore only calls
 * `markAccessLostByInstallation` — the `GithubInstallation` row itself is untouched. If
 * the App is later reinstalled on the same account, `GET /api/github/installations`
 * re-syncs it (`upsertInstallation` is keyed on the `@unique installationId`, so this is
 * an update, not a second row).
 *
 * ## Event/action table this module implements (phase-06 §2's own table)
 *
 * | Event | Action | Behaviour |
 * |---|---|---|
 * | `installation` | `created` | Update existing row only; ignore if absent. |
 * | `installation` | `deleted` | `markAccessLostByInstallation`; row kept. |
 * | `installation` | `suspend` | Set `suspendedAt`; `markAccessLostByInstallation`. |
 * | `installation` | `unsuspend` | Clear `suspendedAt`; `restoreActiveByInstallation`. |
 * | `installation_repositories` | `added` | No-op — see `syncInstallationRepositoriesEvent`. |
 * | `installation_repositories` | `removed` | `markAccessLostByGithubRepoId` per named repo. |
 * | `repository` | `renamed` | `renameByGithubRepoId`. |
 * | `repository` | `deleted` / `archived` | `markAccessLostByGithubRepoId`. |
 * | `repository` | `unarchived` | `restoreActiveByGithubRepoId`. |
 *
 * ## `ACCESS_LOST`, never `DISCONNECTED`
 *
 * Every transition below moves a repository to `ACCESS_LOST`, never `DISCONNECTED` —
 * `Repository`'s own schema comment reserves `DISCONNECTED` for the user's own explicit
 * disconnect (`DELETE /api/repositories/:id`). A webhook-driven transition must never
 * produce it: doing so would make an external GitHub event indistinguishable from a
 * deliberate user action, and the repository would silently vanish from the active list
 * with no explanation in the UI. Every write here goes through
 * `markAccessLostByInstallation`/`markAccessLostByGithubRepoId`/`restoreActiveBy*`, all of
 * which already enforce this: `markAccessLost*` only ever moves `ACTIVE` rows, and
 * `restoreActive*` only ever moves `ACCESS_LOST` rows — a `DISCONNECTED` row is never
 * touched by either direction (see `repository.repository.ts`'s own doc comments on each).
 *
 * ## No `ARCHIVED` connection status
 *
 * There is no dedicated `ARCHIVED` value in `CONNECTION_STATUSES` this phase, and this
 * module does not add one. `ACCESS_LOST` is the closest existing state and is honest
 * enough: an archived GitHub repository is read-only and should not receive reviews. The
 * imprecision is noted here rather than hidden — a later phase can add a dedicated status
 * if it turns out to matter.
 *
 * ## The `WebhookEvent` status these deliveries resolve to
 *
 * `webhook.service.ts`'s `ingestSyncDelivery` marks every delivery this module handles
 * `IGNORED` — the same status `pull_request.edited` already uses for "allow-listed,
 * acted on, no Inngest dispatch." §11's four-state vocabulary (`PENDING`/`DISPATCHED`/
 * `IGNORED`/`FAILED`) stays fixed; nothing here adds a fifth.
 */

const logger = createLogger("webhook.installation-sync");

export type InstallationSyncReason =
  | "INSTALLATION_CREATED_UPDATED"
  | "INSTALLATION_CREATED_NO_EXISTING_ROW"
  | "INSTALLATION_DELETED"
  | "INSTALLATION_SUSPENDED"
  | "INSTALLATION_UNSUSPENDED"
  | "INSTALLATION_REPOSITORIES_ADDED"
  | "INSTALLATION_REPOSITORIES_REMOVED"
  | "REPOSITORY_RENAMED"
  | "REPOSITORY_DELETED"
  | "REPOSITORY_ARCHIVED"
  | "REPOSITORY_UNARCHIVED"
  /** An action `event-allowlist.ts`'s own matrix allow-lists but one of the three
   * switches below does not (yet) branch on — unreachable while the two stay in sync,
   * kept as an explicit "fail safe, do nothing destructive" default rather than a silent
   * fall-through, matching `event-router.ts`'s own identical reasoning for its own
   * unreachable default. */
  | "UNHANDLED_ACTION";

export interface InstallationSyncOutcome {
  reason: InstallationSyncReason;
}

/** GitHub sends `installation.suspended_at` as an ISO-8601 string or `null`; never
 * throws on a malformed one — matches `webhook.schema.ts`'s own "best guess or null,
 * never an exception" discipline for webhook-payload metadata. */
function parseSuspendedAt(value: string | null | undefined): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * `installation.*` — see this file's header for the full argument. `created` is
 * update-only; `deleted`/`suspend`/`unsuspend` all operate on rows page-load sync already
 * created.
 */
export async function syncInstallationEvent(
  payload: ParsedInstallationEvent,
): Promise<InstallationSyncOutcome> {
  const installationId = payload.installation.id;

  switch (payload.action) {
    case "created": {
      const result =
        await installationRepository.updateInstallationMetadataIfExists({
          installationId,
          accountLogin: payload.installation.account.login,
          accountType: payload.installation.account.type,
          suspendedAt: parseSuspendedAt(payload.installation.suspended_at),
        });
      if (!result.updated) {
        // Not an error — the App can be installed by someone who has never signed into
        // this product, and this webhook carries no userId to attribute a new row to.
        // See this file's header comment.
        logger.info(
          "installation.created ignored: no existing GithubInstallation row to update",
          {
            installationId: installationId.toString(),
          },
        );
        return { reason: "INSTALLATION_CREATED_NO_EXISTING_ROW" };
      }
      logger.info(
        "installation.created refreshed an existing GithubInstallation row",
        {
          installationId: installationId.toString(),
        },
      );
      return { reason: "INSTALLATION_CREATED_UPDATED" };
    }
    case "deleted": {
      const changed =
        await repositoryRepository.markAccessLostByInstallation(installationId);
      logger.info("installation.deleted marked repositories ACCESS_LOST", {
        installationId: installationId.toString(),
        repositoriesAffected: changed,
      });
      return { reason: "INSTALLATION_DELETED" };
    }
    case "suspend": {
      await installationRepository.setInstallationSuspendedAt(
        installationId,
        new Date(),
      );
      const changed =
        await repositoryRepository.markAccessLostByInstallation(installationId);
      logger.info("installation.suspend marked repositories ACCESS_LOST", {
        installationId: installationId.toString(),
        repositoriesAffected: changed,
      });
      return { reason: "INSTALLATION_SUSPENDED" };
    }
    case "unsuspend": {
      await installationRepository.setInstallationSuspendedAt(
        installationId,
        null,
      );
      const changed =
        await repositoryRepository.restoreActiveByInstallation(installationId);
      logger.info("installation.unsuspend restored repositories to ACTIVE", {
        installationId: installationId.toString(),
        repositoriesRestored: changed,
      });
      return { reason: "INSTALLATION_UNSUSPENDED" };
    }
    default:
      logger.warn(
        "installation event with an unhandled action reached the sync handler",
        {
          installationId: installationId.toString(),
          action: payload.action,
        },
      );
      return { reason: "UNHANDLED_ACTION" };
  }
}

/**
 * `installation_repositories.*` — repositories added to or removed from an existing
 * installation's access, the installation itself unchanged.
 */
export async function syncInstallationRepositoriesEvent(
  payload: ParsedInstallationRepositoriesEvent,
): Promise<InstallationSyncOutcome> {
  switch (payload.action) {
    case "added":
      // Deliberately a no-op for connection status. Connecting a repository is an
      // explicit user action through POST /api/projects/:id/repositories; the App
      // merely gaining visibility into a repository does not connect it to anything.
      // Handled as its own case (not falling into the default) so this reads as
      // "deliberately does nothing," not a gap nobody noticed.
      logger.info(
        "installation_repositories.added is a no-op for connection status",
        {
          installationId: payload.installation.id.toString(),
          repositoriesAdded: payload.repositories_added?.length ?? 0,
        },
      );
      return { reason: "INSTALLATION_REPOSITORIES_ADDED" };
    case "removed": {
      const githubRepoIds = payload.repositories_removed ?? [];
      let affected = 0;
      for (const repo of githubRepoIds) {
        affected += await repositoryRepository.markAccessLostByGithubRepoId(
          repo.id,
        );
      }
      logger.info(
        "installation_repositories.removed marked repositories ACCESS_LOST",
        {
          installationId: payload.installation.id.toString(),
          repositoriesNamed: githubRepoIds.length,
          repositoriesAffected: affected,
        },
      );
      return { reason: "INSTALLATION_REPOSITORIES_REMOVED" };
    }
    default:
      logger.warn(
        "installation_repositories event with an unhandled action reached the sync handler",
        {
          installationId: payload.installation.id.toString(),
          action: payload.action,
        },
      );
      return { reason: "UNHANDLED_ACTION" };
  }
}

/**
 * `repository.*` — the connected GitHub repository itself was renamed, deleted,
 * archived, or unarchived on GitHub's side. Every transition below is
 * `githubRepoId`-wide, applying to every project connected to this GitHub repository at
 * once — GitHub's own copy of a repository is one thing shared by all of them.
 */
export async function syncRepositoryEvent(
  payload: ParsedRepositoryEvent,
): Promise<InstallationSyncOutcome> {
  const githubRepoId = payload.repository.id;

  switch (payload.action) {
    case "renamed": {
      const changed = await repositoryRepository.renameByGithubRepoId(
        githubRepoId,
        {
          owner: payload.repository.owner.login,
          name: payload.repository.name,
          fullName: payload.repository.full_name,
          htmlUrl: payload.repository.html_url,
        },
      );
      logger.info("repository.renamed updated every connected project's copy", {
        githubRepoId: githubRepoId.toString(),
        fullName: payload.repository.full_name,
        repositoriesAffected: changed,
      });
      return { reason: "REPOSITORY_RENAMED" };
    }
    case "deleted":
    case "archived": {
      // No dedicated ARCHIVED connection status exists this phase — see this file's
      // header comment on why ACCESS_LOST is the honest-enough stand-in for both.
      const changed =
        await repositoryRepository.markAccessLostByGithubRepoId(githubRepoId);
      logger.info(
        `repository.${payload.action} marked repositories ACCESS_LOST`,
        {
          githubRepoId: githubRepoId.toString(),
          repositoriesAffected: changed,
        },
      );
      return {
        reason:
          payload.action === "deleted"
            ? "REPOSITORY_DELETED"
            : "REPOSITORY_ARCHIVED",
      };
    }
    case "unarchived": {
      const changed =
        await repositoryRepository.restoreActiveByGithubRepoId(githubRepoId);
      logger.info("repository.unarchived restored repositories to ACTIVE", {
        githubRepoId: githubRepoId.toString(),
        repositoriesRestored: changed,
      });
      return { reason: "REPOSITORY_UNARCHIVED" };
    }
    default:
      logger.warn(
        "repository event with an unhandled action reached the sync handler",
        {
          githubRepoId: githubRepoId.toString(),
          action: payload.action,
        },
      );
      return { reason: "UNHANDLED_ACTION" };
  }
}
