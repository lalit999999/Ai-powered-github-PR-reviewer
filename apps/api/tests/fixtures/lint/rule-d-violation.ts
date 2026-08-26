// Deliberate boundary violation fixture — Rule D.
// Files under apps/api/src/modules/webhooks/** may not import @repo/github — the
// thin-handler principle: this endpoint makes zero outbound calls. Excluded from the
// normal lint run (see eslint.config.mjs ignores); linted directly by
// apps/api/src/lib/boundaries.test.ts to prove Rule D fires.
import { repositoryGithub } from "@repo/github";

export const client = repositoryGithub;
