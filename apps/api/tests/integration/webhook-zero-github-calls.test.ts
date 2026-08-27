import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@repo/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "./db-helpers.js";
import { loadWebhookFixture, newDeliveryId, postWebhook, seedWebhookTenant } from "./webhook-helpers.js";

/**
 * Sub-task 5.4 — §14 External Service Verification: "Confirm zero outbound GitHub API
 * calls occur during webhook processing, via request logging — this is the direct
 * verification of the thin-handler principle."
 *
 * Two independent checks, because neither alone is sufficient (see each `describe`
 * block's own comment for what the other one misses):
 *
 * - **Static** (`eslint.config.mjs`'s Rule D already forbids the import at lint time —
 *   this is a *test-time* re-assertion that the rule's glob actually covers every file
 *   that exists today, so a subdirectory added later without updating the glob fails
 *   this suite loudly rather than silently losing coverage).
 * - **Runtime** (a real delivery, driven through the real app, with `globalThis.fetch`
 *   spied on for its duration) — this is what would catch a transitive import Rule D's
 *   `no-restricted-imports` pattern does not match, or a hand-written `fetch()` call that
 *   bypasses `@repo/github` entirely.
 */

const WEBHOOKS_MODULE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/modules/webhooks");

function listFilesRecursive(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(full));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(full);
    }
  }
  return files;
}

describe("the webhooks module makes zero outbound GitHub API calls — static", () => {
  it("no file under apps/api/src/modules/webhooks/** imports @repo/github or reaches into packages/github's internals", () => {
    const files = listFilesRecursive(WEBHOOKS_MODULE_DIR);
    // Sanity: this must actually enumerate something, or the assertion below would pass
    // vacuously on an empty list — a glob-covers-nothing bug hiding as a green test.
    expect(files.length).toBeGreaterThan(5);

    const offenders: { file: string; line: string }[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const line of content.split("\n")) {
        if (/from\s+["']@repo\/github/.test(line) || /require\(["']@repo\/github/.test(line) || /packages\/github\/src/.test(line)) {
          offenders.push({ file: path.relative(WEBHOOKS_MODULE_DIR, file), line: line.trim() });
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Runtime — a real delivery, a real fetch spy.
// ---------------------------------------------------------------------------

vi.mock("../../src/inngest/emit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/inngest/emit.js")>();
  return { ...actual, emitPullRequestReviewRequested: vi.fn() };
});

const { emitPullRequestReviewRequested } = await import("../../src/inngest/emit.js");
const { default: app } = await import("../../src/app.js");

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(emitPullRequestReviewRequested).mockReset();
  vi.mocked(emitPullRequestReviewRequested).mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the webhooks module makes zero outbound GitHub API calls — runtime", () => {
  it("a full pull_request delivery never calls fetch against any github.com host", async () => {
    const tenant = await seedWebhookTenant();
    const { text } = loadWebhookFixture("pull-request-opened.json", { installationId: Number(tenant.installationId) });
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn((...args: Parameters<typeof fetch>) => originalFetch(...args));
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const res = await postWebhook(app, { body: text, event: "pull_request", deliveryId: newDeliveryId() });
      expect(res.status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }

    const githubCalls = fetchSpy.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      return /(^|\.)github\.com$/.test(new URL(url).hostname) || url.includes("githubusercontent.com");
    });
    expect(githubCalls).toEqual([]);
  });
});
