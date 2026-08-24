// Deliberate boundary violation fixture — Rule A.
// An API route/controller must not import the ai/indexing/retrieval packages directly.
// Excluded from the normal lint run (see eslint.config.mjs ignores); linted directly
// by apps/api/src/lib/boundaries.test.ts to prove Rule A fires.
import { review } from "@repo/ai";

export const handler = () => review();
