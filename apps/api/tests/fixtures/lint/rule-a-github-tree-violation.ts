// Deliberate boundary violation fixture — Rule A, GitHub-client tree.
// Rule A's first pattern group already blocks a plain `@repo/github` import (same as
// `@repo/ai`). This fixture proves the narrower thing that pattern *cannot* catch: a
// deep relative import reaching past @repo/github's public index.ts straight into its
// internals. Excluded from the normal lint run (see eslint.config.mjs ignores); linted
// directly by apps/api/src/lib/boundaries.test.ts to prove the widened Rule A fires.
// See docs/decisions/phase-03-log.md, sub-task 1.1 (previously a relative import of
// apps/api/src/github/**, before Phase 03 promoted the client to packages/github —
// docs/decisions/phase-02-log.md §10).
import { createInstallationOctokit } from "../../../../../packages/github/src/client/octokit-factory.js";

export const handler = () => createInstallationOctokit(1n);
