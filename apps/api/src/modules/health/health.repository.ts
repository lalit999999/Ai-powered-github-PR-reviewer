import { prisma } from "@repo/db";

/**
 * Trivial connectivity check — the only DB touch point for GET /api/health. Lives here
 * (not in the controller) because only the repository layer may import `@repo/db`'s
 * Prisma-backed exports (Rule B, phase-00 §3, docs/decisions/phase-00-log.md §2).
 */
export async function pingDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
