// Deliberate boundary violation fixture — Rule A.
// An API route/controller must not import the ai/indexing/retrieval packages directly.
// Excluded from the normal lint run (see eslint.config.mjs ignores); linted directly
// by apps/api/src/lib/boundaries.test.ts to prove Rule A fires.
import { review } from "@repo/ai";
// The correctly-spelled embeddings package name (Phase 05 prompt 3) — proves Rule A's
// pattern group catches this name too, not just the "@repo/embedings" typo.
import { chunkFile } from "@repo/embeddings";

export const handler = () => review();
export const chunk = () => chunkFile;
