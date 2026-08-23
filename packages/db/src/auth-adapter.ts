import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "./client";

/**
 * Constructed here, not in apps/api's auth config, because only packages/db and
 * *.repository.ts files may hold Prisma-shaped code (Rule B, phase-00 §3,
 * docs/decisions/phase-00-log.md §2). apps/api imports this pre-built adapter and
 * never touches @prisma/client or the generated client directly.
 */
export const authAdapter = PrismaAdapter(prisma);
