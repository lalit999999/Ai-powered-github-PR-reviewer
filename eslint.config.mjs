import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Architectural boundary rules for the whole monorepo (Phase 00 §3 / plan.md §44.1),
// adapted onto this repo's actual apps/* + packages/* split — see
// docs/decisions/phase-00-log.md §1-2 for why the paths below differ from the phase
// document's single-src/-tree layout.
//
// Rule A — the API layer (apps/api routes/controllers) may not import the future
//          ai/indexing/retrieval packages directly (phase-00 §3: "route handlers may
//          not import indexing/*, ai/*, retrieval/*").
// Rule B — only the repository layer (packages/db/** or a *.repository.ts file) may
//          import @prisma/client or reach into packages/db's generated client.
// Rule C — Inngest functions (apps/worker) may not import the API layer's
//          routes/controllers directly.
//
// Each rule's `files` list includes both its real target path and a matching fixture
// under tests/fixtures/lint/, so the fixtures exercise the exact same rule config as
// production code. The fixtures directory is globally ignored below so `pnpm lint`
// never trips on the deliberate violations; a dedicated test lints them directly with
// ignores disabled (see apps/api/src/lib/boundaries.test.ts).

const RULE_A_FILES = [
  "apps/api/src/routes/**/*.ts",
  "apps/api/src/controllers/**/*.ts",
  "apps/api/tests/fixtures/lint/rule-a-violation.ts",
];

const RULE_B_FILES = [
  "apps/**/src/**/*.ts",
  "packages/**/src/**/*.ts",
  "apps/api/tests/fixtures/lint/rule-b-violation.ts",
];

const RULE_C_FILES = [
  "apps/worker/src/functions/**/*.ts",
  "apps/api/tests/fixtures/lint/rule-c-violation.ts",
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/dist/**",
      "**/build/**",
      "**/generated/**",
      "**/tests/fixtures/lint/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Root-level CommonJS tooling config (prettier.config.js etc.) — not application
    // source, pre-dates this rule set, needs Node globals for module.exports.
    files: ["**/*.config.js", "**/*.config.cjs"],
    languageOptions: {
      globals: { module: "writable", require: "readonly", exports: "writable" },
    },
  },
  {
    // No bare console.log in application source (structured logging only —
    // Architecture Rules). Fixtures/config files are exempt.
    files: ["apps/**/src/**/*.ts", "apps/**/src/**/*.tsx", "packages/**/src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // Rule A
    files: RULE_A_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@repo/ai", "@repo/ai/*", "@repo/github", "@repo/github/*", "@repo/embedings", "@repo/embedings/*"],
              message:
                "API routes/controllers may not import the ai/github/embedings (ai/indexing/retrieval) packages directly — go through a module service instead (Rule A, phase-00 §3).",
            },
          ],
        },
      ],
    },
  },
  {
    // Rule B
    files: RULE_B_FILES,
    ignores: ["packages/db/**", "**/*.repository.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@prisma/client",
              message:
                "Only the repository layer (packages/db/** or a *.repository.ts file) may import @prisma/client — import the `prisma` singleton from @repo/db instead (Rule B, phase-00 §3, reconciled in docs/decisions/phase-00-log.md §2).",
            },
          ],
          patterns: [
            {
              group: ["@repo/db/src/generated/*", "**/generated/client*"],
              message: "Do not deep-import the generated Prisma client — import `prisma` from @repo/db (Rule B).",
            },
          ],
        },
      ],
    },
  },
  {
    // Rule C
    files: RULE_C_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/api/src/routes/**", "**/api/src/controllers/**"],
              message: "Inngest functions (apps/worker) may not import the API layer's routes/controllers directly (Rule C, phase-00 §3).",
            },
          ],
        },
      ],
    },
  }
);
