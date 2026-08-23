import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Proves the three architectural boundary rules in the root eslint.config.mjs (Rule A/B/C,
// phase-00 §3) actually fire. The fixtures under tests/fixtures/lint/ are globally ignored
// by the normal `pnpm lint` run (see eslint.config.mjs) — `ignore: false` here bypasses
// that so this test exercises the exact same rule config against them directly.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ESLINT_CONFIG = path.join(REPO_ROOT, "eslint.config.mjs");
const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/lint");

async function lintFixture(filename: string) {
  const eslint = new ESLint({ cwd: REPO_ROOT, overrideConfigFile: ESLINT_CONFIG, ignore: false });
  const [result] = await eslint.lintFiles([path.join(FIXTURES_DIR, filename)]);
  return result;
}

describe("architectural boundary lint rules", () => {
  it("Rule A fails: API routes/controllers may not import ai/indexing/retrieval packages directly", async () => {
    const result = await lintFixture("rule-a-violation.ts");
    expect(result?.errorCount).toBeGreaterThan(0);
    expect(result?.messages.some((m) => m.ruleId === "no-restricted-imports" && /Rule A/.test(m.message))).toBe(true);
  });

  it("Rule B fails: only the repository layer may import @prisma/client", async () => {
    const result = await lintFixture("rule-b-violation.ts");
    expect(result?.errorCount).toBeGreaterThan(0);
    expect(result?.messages.some((m) => m.ruleId === "no-restricted-imports" && /Rule B/.test(m.message))).toBe(true);
  });

  it("Rule C fails: Inngest functions may not import the API layer's routes/controllers", async () => {
    const result = await lintFixture("rule-c-violation.ts");
    expect(result?.errorCount).toBeGreaterThan(0);
    expect(result?.messages.some((m) => m.ruleId === "no-restricted-imports" && /Rule C/.test(m.message))).toBe(true);
  });
});
