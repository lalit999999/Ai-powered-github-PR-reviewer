import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@repo/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./db-helpers.js";

const DB_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/db");

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// Updated for phase-01 §6's field-complete models (see docs/decisions/phase-01-log.md).
// Phase-00's placeholder-only assertions ("no premature schema creep" against the
// two-column placeholder shape) no longer apply by design — Phase 01 intentionally
// supersedes them — so this file now asserts the field-complete shape instead of being
// deleted, per the migration note in phase-01-authentication-and-projects.md §6.
describe("prisma migration pipeline + field-complete models (phase-01 §6/§14)", () => {
  it("prisma migrate status reports no pending migrations after migrate deploy", () => {
    const output = execFileSync("pnpm", ["exec", "prisma", "migrate", "status"], {
      cwd: DB_PACKAGE_DIR,
      env: process.env,
      encoding: "utf-8",
    });
    expect(output).toContain("Database schema is up to date");
  });

  it("round-trips a User and a Project insert and enforces (userId, slug) uniqueness", async () => {
    const user = await prisma.user.create({
      data: { githubUserId: 1001n, githubLogin: "octocat" },
    });
    expect(user.id).toBeTruthy();
    expect(user.plan).toBe("free");
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);

    const project = await prisma.project.create({
      data: { userId: user.id, name: "Test Project", slug: "test-project" },
    });
    expect(project.id).toBeTruthy();
    expect(project.userId).toBe(user.id);
    expect(project.settings).toEqual({});
    expect(project.deletedAt).toBeNull();

    const fetchedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const fetchedProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(fetchedUser.id).toBe(user.id);
    expect(fetchedProject.userId).toBe(user.id);

    await expect(
      prisma.project.create({ data: { userId: user.id, name: "Duplicate slug", slug: "test-project" } }),
    ).rejects.toThrow();
  });

  it("User/Project have exactly the field-complete + Auth.js adapter columns — no premature schema creep", async () => {
    const userColumns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'User' ORDER BY column_name;`,
    );
    expect(userColumns.map((c) => c.column_name).sort()).toEqual(
      [
        "avatarUrl",
        "createdAt",
        "email",
        "emailVerified",
        "githubLogin",
        "githubUserId",
        "id",
        "image",
        "name",
        "plan",
        "updatedAt",
      ].sort(),
    );

    const projectColumns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'Project' ORDER BY column_name;`,
    );
    expect(projectColumns.map((c) => c.column_name).sort()).toEqual(
      ["createdAt", "deletedAt", "id", "name", "settings", "slug", "updatedAt", "userId"].sort(),
    );
  });
});
