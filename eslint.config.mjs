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
// Rule D — the webhooks module (apps/api/src/modules/webhooks/**) may not import
//          @repo/github/@repo/ai/@repo/embedings or reach into packages/github/src/**
//          — the thin-handler principle (phase-06 §22): this endpoint makes zero
//          outbound calls, and a well-meaning future change ("just fetch the PR's base
//          branch here") is exactly the regression this rule exists to catch mechanically.
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
  "apps/api/tests/fixtures/lint/rule-a-github-tree-violation.ts",
];

const RULE_B_FILES = [
  "apps/**/src/**/*.ts",
  "packages/**/src/**/*.ts",
  "apps/api/tests/fixtures/lint/rule-b-violation.ts",
];

const RULE_C_FILES = [
  // Written before apps/worker existed; corrected to match the actual structure
  // Prompt 2 built (matching plan.md §44 / phase-00 §8's src/inngest/functions/
  // convention) — see docs/decisions/phase-01-log.md.
  "apps/worker/src/inngest/functions/**/*.ts",
  "apps/api/tests/fixtures/lint/rule-c-violation.ts",
];

const RULE_D_FILES = [
  "apps/api/src/modules/webhooks/**/*.ts",
  "apps/api/tests/fixtures/lint/rule-d-violation.ts",
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
      // Phase-04 Prompt 2's golden-file parser fixtures (apps/worker/tests/fixtures/
      // parsing/) are read as raw text by typescript.adapter.golden.test.ts, never
      // imported or compiled — one is deliberately malformed syntax, and several use
      // unused type parameters/decorator arguments on purpose to exercise those
      // constructs. Real source-quality rules do not apply to fixture data.
      "**/tests/fixtures/parsing/**",
      // Phase-04 Prompt 5's graph-fixture repository (apps/worker/tests/fixtures/
      // graph-repo/) — committed source for the precision measurement and structural
      // graph tests, read as raw text by the parsing pipeline. Deliberately contains
      // unresolvable imports, an unparseable file, and same-named-export collisions;
      // real source-quality rules do not apply here either, same reasoning as the
      // parsing fixtures above.
      "**/tests/fixtures/graph-repo/**",
      // apps/web has its own complete, Next.js-flavored eslint.config.mjs (react-hooks,
      // react-compiler, etc.) run via `turbo lint` — linting it again here with this
      // generic config would conflict rather than add coverage.
      "apps/web/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Standard "intentionally unused" convention — Express's errorHandler(err, req, res,
    // next) must keep unused params to preserve its 4-arg arity (Express detects
    // error-handling middleware by Function.length).
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
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
    files: [
      "apps/**/src/**/*.ts",
      "apps/**/src/**/*.tsx",
      "packages/**/src/**/*.ts",
    ],
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
              group: [
                "@repo/ai",
                "@repo/ai/*",
                "@repo/github",
                "@repo/github/*",
                "@repo/embedings",
                "@repo/embedings/*",
              ],
              message:
                "API routes/controllers may not import the ai/github/embedings (ai/indexing/retrieval) packages directly — go through a module service instead (Rule A, phase-00 §3).",
            },
            {
              // Phase 02 put the GitHub App client inside apps/api itself
              // (apps/api/src/github/**) rather than in a @repo/github package, so a
              // controller reaching it by *relative* path would never have matched the
              // package-name patterns above (docs/decisions/phase-02-log.md §10). Phase
              // 03 promoted the client to the real packages/github package the pattern
              // above already names — closing that original hole — but a route could
              // still reach *past* the package's public index.ts into its internals via
              // a long relative path (`../../../../packages/github/src/client/...`),
              // which is the same class of bypass in a new shape. This pattern group now
              // exists for that narrower case; see docs/decisions/phase-03-log.md,
              // sub-task 1.1.
              group: [
                "**/src/github/**",
                "**/github/client/*",
                "**/github/services/*",
                // packages/github's own internal layout — added when the client moved
                // there in Phase 03. The three patterns above are pre-Phase-03 and no
                // longer match anything real (nothing lives at apps/api/src/github/**
                // any more), but are kept: a future relative-path GitHub client
                // re-embedded in an app should still be caught.
                "**/packages/github/src/**",
              ],
              message:
                "API routes/controllers may not import the GitHub client directly — go through a module service instead, and never reach past @repo/github's public index into its internals (Rule A, phase-00 §3, extended in phase-02/phase-03).",
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
              message:
                "Do not deep-import the generated Prisma client — import `prisma` from @repo/db (Rule B).",
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
              message:
                "Inngest functions (apps/worker) may not import the API layer's routes/controllers directly (Rule C, phase-00 §3).",
            },
          ],
        },
      ],
    },
  },
  {
    // Rule D
    files: RULE_D_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@repo/ai",
                "@repo/ai/*",
                "@repo/github",
                "@repo/github/*",
                "@repo/embedings",
                "@repo/embedings/*",
                "**/packages/github/src/**",
              ],
              message:
                "The webhooks module (apps/api/src/modules/webhooks/**) may not import the ai/github/embedings packages, or reach into packages/github's internals — this endpoint makes zero outbound calls, the thin-handler principle (Rule D, phase-06 §22).",
            },
          ],
        },
      ],
    },
  },
);
