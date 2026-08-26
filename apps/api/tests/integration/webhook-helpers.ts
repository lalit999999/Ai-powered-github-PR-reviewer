import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { prisma } from "@repo/db";
import request from "supertest";
import type { Test } from "supertest";
import { WEBHOOK_GITHUB_PATH } from "../../src/modules/webhooks/webhook.routes-path.js";

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/webhooks");

/**
 * Shared setup for the webhook ingestion integration suite (`webhooks.test.ts` and its
 * siblings), mirroring `repository-helpers.ts`/`auth-helpers.ts`'s role: real Prisma
 * rows and byte-exact HTTP plumbing for the parts of the flow a given test is not itself
 * exercising.
 *
 * Sub-task 5.1's own two load-bearing details live here — see each function's own
 * comment.
 */

// ---------------------------------------------------------------------------
// Signing — independent of the code under test.
// ---------------------------------------------------------------------------

/**
 * Signs `body` with GitHub's own HMAC-SHA256-over-the-raw-body algorithm — computed
 * **independently** here, via `node:crypto` directly, rather than by importing
 * `verifyWebhookSignature` from `webhook-verification.ts`. This is the single most
 * important line in this file: if this helper called the production verifier (or shared
 * any code path with it) to produce its signatures, a bug in the verifier's HMAC
 * computation would be invisible to every test in this suite — both sides would compute
 * the same wrong value, "verify" it against each other, and every signature test would
 * pass while the real GitHub integration silently failed. Reimplementing the four-line
 * algorithm here, from the primitive `createHmac` call up, is what makes a bug in
 * `webhook-verification.ts` detectable at all.
 */
export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// postWebhook — byte-exact delivery.
// ---------------------------------------------------------------------------

export interface PostWebhookOptions {
  /** The EXACT string to send as the request body — never re-serialized by this
   * function or by supertest. Callers pass `JSON.stringify(fixture)` themselves (or a
   * hand-crafted string, for the whitespace-regression test) so the string that gets
   * signed is provably the same string that gets sent. */
  body: string;
  /** Omit entirely to exercise the missing-`x-github-event`-header case. */
  event?: string;
  /** Omit entirely to exercise the missing-`x-github-delivery`-header case. */
  deliveryId?: string;
  /** Omit for a correctly-signed request (computed from `body` and the real
   * `GITHUB_APP_WEBHOOK_SECRET` env value); pass a string to override it (a tampered or
   * wrong-secret signature); pass `null` to omit the header entirely (the
   * missing-signature case). */
  signature?: string | null;
  contentType?: string;
}

/**
 * Posts a webhook delivery to the real Express app at `WEBHOOK_GITHUB_PATH`.
 *
 * **Sends `body` via `.send(rawString)` with an explicit `Content-Type`, never
 * `.send(parsedObject)`.** This is the second load-bearing detail this file exists to
 * get right: supertest/superagent's `.send()` re-serializes a plain object argument
 * through its own `JSON.stringify`, which can reorder keys or normalize whitespace
 * relative to whatever string a test signed — corrupting the exact byte sequence the
 * signature was computed over, in exactly the way `webhook-verification.ts`'s own header
 * comment names as this phase's most common implementation bug. Passing a string (this
 * function's only accepted `body` type) short-circuits that: superagent's `Request.send`
 * only stringifies when its argument is not already a string, so a string argument is
 * written to the wire byte-for-byte.
 *
 * **Verified empirically, not just reasoned about**: a throwaway assertion added during
 * development of this helper (`req.on("response", ...)` was not needed — a server-side
 * `console.log(rawBody.equals(Buffer.from(expectedString)))` inside a temporary route
 * stub, run once against this exact call shape) confirmed the bytes Express's
 * `express.raw()` middleware receives are identical to the `body` string passed in here,
 * for both an ordinary payload and the deliberately-irregular-whitespace one
 * `webhooks.test.ts`'s regression-guard test uses. That temporary logging was removed
 * once confirmed; this comment records what it showed.
 */
export function postWebhook(app: Express, opts: PostWebhookOptions): Test {
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET ?? "local-dev-webhook-secret";
  const signature = opts.signature === undefined ? signWebhookBody(opts.body, secret) : opts.signature;

  const req = request(app).post(WEBHOOK_GITHUB_PATH).set("Content-Type", opts.contentType ?? "application/json");

  if (opts.event !== undefined) {
    req.set("x-github-event", opts.event);
  }
  if (opts.deliveryId !== undefined) {
    req.set("x-github-delivery", opts.deliveryId);
  }
  if (signature !== null) {
    req.set("x-hub-signature-256", signature);
  }

  return req.send(opts.body);
}

/** A fresh, realistic `X-GitHub-Delivery` value — GitHub's own format is a UUID. */
export function newDeliveryId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Fixture loading.
// ---------------------------------------------------------------------------

let fixtureInstallationSeq = 60_200_000;

/**
 * Loads a fixture from `tests/fixtures/webhooks/`, assigns it a **fresh,
 * per-call-unique** `installation.id` (unless one is passed explicitly), and returns
 * both the mutated object and its `JSON.stringify`'d text.
 *
 * The unique-installation-id default exists for a reason that has nothing to do with
 * routing correctness and everything to do with test isolation: `webhooks.controller.ts`
 * rate-limits by `installationId` extracted straight from the payload
 * (`webhook-rate-limit.ts`, 100/60s), against the **real** Redis this integration suite
 * runs against (only Postgres is a fresh Testcontainers instance per run — Redis is the
 * shared local dev instance, and its keys do not reset between test files). Every test in
 * this suite sharing one hardcoded `installation.id` (as the raw fixture files do, for
 * readability) would mean the whole suite's request count accumulates against one 60-
 * second window and could spuriously 200/no-op a later test once the 100th request in
 * that window is reached — a source of exactly the kind of flakiness that would be
 * maddening to diagnose. Giving each loaded fixture its own installation id by default
 * makes every test's rate-limit bucket independent of every other test's, the same
 * isolation `installationSeq` gives `repository-helpers.ts`'s `seedInstallation`.
 */
export function loadWebhookFixture(
  name: string,
  opts: { installationId?: number; mutate?: (payload: Record<string, unknown>) => void } = {},
): { payload: Record<string, unknown>; text: string } {
  const raw = readFileSync(path.join(FIXTURES_DIR, name), "utf8");
  const payload = JSON.parse(raw) as Record<string, unknown>;

  fixtureInstallationSeq += 1;
  const installationId = opts.installationId ?? fixtureInstallationSeq;
  const installation = payload.installation;
  if (installation && typeof installation === "object") {
    (installation as Record<string, unknown>).id = installationId;
  }

  opts.mutate?.(payload);

  return { payload, text: JSON.stringify(payload) };
}

// ---------------------------------------------------------------------------
// Tenant seeding.
// ---------------------------------------------------------------------------

let seq = 0;

export interface SeededWebhookTenant {
  userId: string;
  projectId: string;
  repositoryId: string;
  githubRepoId: bigint;
  fullName: string;
  installationId: bigint;
}

/**
 * Seeds a full tenant chain — `User` → `Project` → `GithubInstallation` → `Repository`
 * (`connectionStatus: ACTIVE`) — directly through Prisma, matching
 * `repository-helpers.ts`'s own "seed what this suite doesn't exercise" convention: this
 * suite's job is `POST /api/webhooks/github`'s own behavior, not the connect flow, so
 * there is no reason to drive tenant setup through HTTP.
 *
 * `githubRepoId`/`fullName` default to values matching the `octocat/hello-world`
 * fixtures in `tests/fixtures/webhooks/` (`1296269` / `"octocat/hello-world"`) so a test
 * can seed a tenant and post the default fixture with zero further wiring; both are
 * overridable for tests that need a different repository.
 */
export async function seedWebhookTenant(
  userId?: string,
  opts: { githubRepoId?: bigint; fullName?: string; installationId?: bigint; projectSettings?: unknown } = {},
): Promise<SeededWebhookTenant> {
  seq += 1;

  const resolvedUserId =
    userId ??
    (
      await prisma.user.create({
        data: { githubUserId: BigInt(3_000_000 + seq), githubLogin: `webhook-fixture-user-${seq}`, email: `webhook-fixture-${seq}@example.com` },
      })
    ).id;

  const project = await prisma.project.create({
    data: {
      userId: resolvedUserId,
      name: `Webhook Fixture Project ${seq}`,
      slug: `webhook-fixture-project-${seq}`,
      settings: (opts.projectSettings ?? {}) as object,
    },
  });

  const installationId = opts.installationId ?? BigInt(60_123_456);
  await prisma.githubInstallation.upsert({
    where: { installationId },
    create: { installationId, accountLogin: "octocat", accountType: "User", userId: resolvedUserId },
    update: {},
  });

  const githubRepoId = opts.githubRepoId ?? BigInt(1_296_269);
  const fullName = opts.fullName ?? "octocat/hello-world";
  const [owner, name] = fullName.split("/") as [string, string];

  const repository = await prisma.repository.create({
    data: {
      projectId: project.id,
      installationId,
      githubRepoId,
      owner,
      name,
      fullName,
      defaultBranch: "main",
      isPrivate: false,
      htmlUrl: `https://github.com/${fullName}`,
      connectionStatus: "ACTIVE",
    },
  });

  return {
    userId: resolvedUserId,
    projectId: project.id,
    repositoryId: repository.id,
    githubRepoId,
    fullName,
    installationId,
  };
}

/**
 * Connects the SAME `githubRepoId` a first tenant already has to a brand-new project
 * under the same user — the fan-out setup every dual-tenant test in `webhooks.test.ts`
 * needs (§34.3's named failure point). A second, independent `Repository` row, same
 * `githubRepoId`, different `projectId` — exactly the shape
 * `findConnectedByGithubRepoId` fans a single delivery out across.
 */
export async function seedSecondProjectForSameRepo(
  userId: string,
  githubRepoId: bigint,
  opts: { fullName?: string; installationId?: bigint; projectSettings?: unknown } = {},
): Promise<{ projectId: string; repositoryId: string }> {
  seq += 1;

  const project = await prisma.project.create({
    data: {
      userId,
      name: `Webhook Fixture Second Project ${seq}`,
      slug: `webhook-fixture-second-project-${seq}`,
      settings: (opts.projectSettings ?? {}) as object,
    },
  });

  const installationId = opts.installationId ?? BigInt(60_123_456);
  await prisma.githubInstallation.upsert({
    where: { installationId },
    create: { installationId, accountLogin: "octocat", accountType: "User", userId },
    update: {},
  });

  const fullName = opts.fullName ?? "octocat/hello-world";
  const [owner, name] = fullName.split("/") as [string, string];

  const repository = await prisma.repository.create({
    data: {
      projectId: project.id,
      installationId,
      githubRepoId,
      owner,
      name,
      fullName,
      defaultBranch: "main",
      isPrivate: false,
      htmlUrl: `https://github.com/${fullName}`,
      connectionStatus: "ACTIVE",
    },
  });

  return { projectId: project.id, repositoryId: repository.id };
}
