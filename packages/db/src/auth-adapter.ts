import type { Adapter } from "@auth/core/adapters";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "./client.js";

/**
 * Constructed here, not in apps/api's auth config, because only packages/db and
 * *.repository.ts files may hold Prisma-shaped code (Rule B, phase-00 §3,
 * docs/decisions/phase-00-log.md §2). apps/api imports this pre-built adapter and
 * never touches @prisma/client or the generated client directly.
 *
 * The explicit `Adapter` annotation is required once this package emits `.d.ts`
 * (phase-03 §1.7) — without it, tsc's inferred type references `Adapter` through a
 * pnpm-internal virtual store path (`.pnpm/@auth+core@.../node_modules/...`), which is
 * not a portable type for a declaration file to name.
 */
export const authAdapter: Adapter = PrismaAdapter(prisma);
