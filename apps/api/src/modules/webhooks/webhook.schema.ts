import { z } from "zod";
import { PULL_REQUEST_STATES } from "@repo/shared";

/**
 * Zod schemas for the *subset* of each GitHub webhook payload this phase actually
 * reads — not the whole payload. GitHub's `pull_request` event alone runs to a hundred
 * or more fields; modelling all of it here would be both pointless (nothing in this
 * phase reads most of it) and a maintenance liability (every GitHub payload addition
 * would be a spurious diff in a file nothing downstream needed to change for).
 *
 * ## Loose parsing, not strict — on every schema in this file
 *
 * Every object schema ends in `.passthrough()`. GitHub adds fields to its webhook
 * payloads without notice, and a strict schema (`z.object(...).strict()`, or the zod
 * default of rejecting unknown keys) would turn a benign GitHub product update into a
 * production outage the next time a payload arrived with a field this file did not
 * anticipate. This file validates what it reads and ignores everything else, on
 * purpose.
 *
 * ## GitHub ids: JSON numbers in, `bigint` out
 *
 * `repository.id` and `pull_request.id` are int64 on GitHub's side but arrive as plain
 * JSON numbers. `JSON.parse` has already done any precision-losing rounding by the time
 * this code sees the value — for an id past `Number.MAX_SAFE_INTEGER`, the imprecision
 * happened on the wire, not here, and there is nothing this layer can do to recover
 * information JSON's own number format never carried in the first place. `githubBigIntId`
 * converts with `BigInt(Math.trunc(n))`, which is lossless for every id GitHub has
 * issued to date, and says so rather than silently rounding and hoping nobody notices.
 *
 * Contrast this with `repository.schema.ts`'s `githubIdSchema`, which parses a
 * **string** and can afford to be strict about it (a regex-anchored positive integer)
 * — because that input comes from our own client, over our own API, where we control
 * the wire format end to end. A webhook payload's id comes from GitHub's JSON, where the
 * wire format itself is the limiting factor. The two schemas look inconsistent
 * side by side; they are solving different problems.
 */

function githubBigIntId() {
  return z.number().transform((value) => BigInt(Math.trunc(value)));
}

const installationRefSchema = z.object({ id: githubBigIntId() }).passthrough();

const repositoryRefSchema = z
  .object({
    id: githubBigIntId(),
    full_name: z.string(),
    name: z.string(),
    owner: z.object({ login: z.string() }).passthrough(),
    html_url: z.string(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// pull_request — the fields Prompt 2's router and persistence actually read.
// ---------------------------------------------------------------------------

const pullRequestRefSchema = z
  .object({
    id: githubBigIntId(),
    number: z.number(),
    state: z.enum(PULL_REQUEST_STATES),
    draft: z.boolean(),
    head: z.object({ sha: z.string() }).passthrough(),
    base: z.object({ sha: z.string() }).passthrough(),
  })
  .passthrough();

export const pullRequestEventSchema = z
  .object({
    action: z.string(),
    number: z.number(),
    pull_request: pullRequestRefSchema,
    repository: repositoryRefSchema,
    installation: installationRefSchema,
  })
  .passthrough();

export type ParsedPullRequestEvent = z.infer<typeof pullRequestEventSchema>;

// ---------------------------------------------------------------------------
// installation / installation_repositories / repository / ping — declared now so
// Prompt 4's sync handlers have a settled parsing boundary to build on. Nothing in
// Prompt 2 constructs or consumes these; only `pullRequestEventSchema` is used by
// `webhook.service.ts` today.
// ---------------------------------------------------------------------------

export const installationEventSchema = z
  .object({
    action: z.string(),
    installation: z
      .object({
        id: githubBigIntId(),
        account: z.object({ login: z.string(), type: z.string() }).passthrough(),
        // GitHub sends this on every `installation.*` action, not only `suspend`/
        // `unsuspend` — carried here so `installation.created`'s update-only sync
        // (Prompt 4 §2) can refresh it along with accountLogin/accountType, rather than
        // only ever setting it from the dedicated suspend/unsuspend actions.
        suspended_at: z.string().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type ParsedInstallationEvent = z.infer<typeof installationEventSchema>;

export const installationRepositoriesEventSchema = z
  .object({
    action: z.string(),
    installation: installationRefSchema,
    repositories_added: z.array(repositoryRefSchema).optional(),
    repositories_removed: z.array(repositoryRefSchema).optional(),
  })
  .passthrough();

export type ParsedInstallationRepositoriesEvent = z.infer<typeof installationRepositoriesEventSchema>;

export const repositoryEventSchema = z
  .object({
    action: z.string(),
    repository: repositoryRefSchema,
    installation: installationRefSchema.optional(),
  })
  .passthrough();

export type ParsedRepositoryEvent = z.infer<typeof repositoryEventSchema>;

export const pingEventSchema = z
  .object({
    zen: z.string().optional(),
    repository: repositoryRefSchema.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Best-effort extraction for audit metadata on deliveries this file does not fully
// validate (a malformed pull_request payload, or an event type this phase does not
// route anywhere — ping/push). These never throw and never require the full schema to
// have passed: `WebhookEvent.installationId`/`repositoryFullName` are routing metadata
// for the audit ledger, not data this phase trusts for anything else, so "best guess or
// null" is the right contract — never an exception that would turn a malformed-but-
// authentic delivery into an unhandled 500 (phase-06 §0).
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function extractInstallationId(rawPayload: unknown): bigint | null {
  const installation = asRecord(asRecord(rawPayload)?.installation);
  const id = installation?.id;
  return typeof id === "number" ? BigInt(Math.trunc(id)) : null;
}

export function extractRepositoryFullName(rawPayload: unknown): string | null {
  const repository = asRecord(asRecord(rawPayload)?.repository);
  const fullName = repository?.full_name;
  return typeof fullName === "string" ? fullName : null;
}

export function extractAction(rawPayload: unknown): string | null {
  const action = asRecord(rawPayload)?.action;
  return typeof action === "string" ? action : null;
}
