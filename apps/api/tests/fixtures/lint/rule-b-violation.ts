// Deliberate boundary violation fixture — Rule B.
// Only the repository layer (packages/db/** or a *.repository.ts file) may import
// @prisma/client. Excluded from the normal lint run (see eslint.config.mjs ignores);
// linted directly by apps/api/src/lib/boundaries.test.ts to prove Rule B fires.
import { PrismaClient } from "@prisma/client";

export const client = new PrismaClient();
