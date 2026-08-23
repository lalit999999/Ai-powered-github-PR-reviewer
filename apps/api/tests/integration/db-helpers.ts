import { prisma } from "@repo/db";

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Project", "User" RESTART IDENTITY CASCADE;');
}
