// Deliberate boundary violation fixture — Rule A, GitHub-client tree.
// Rule A originally only named the @repo/* packages. Phase 02 put the GitHub client
// inside apps/api itself (apps/api/src/github/**), where a relative import from a
// controller would have sailed past the package-name patterns. Excluded from the normal
// lint run (see eslint.config.mjs ignores); linted directly by
// apps/api/src/lib/boundaries.test.ts to prove the widened Rule A fires.
import { createInstallationOctokit } from "../../../src/github/client/octokit-factory.js";

export const handler = () => createInstallationOctokit(1n);
