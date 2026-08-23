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

describe("prisma migration pipeline + placeholder models (phase-00 §6/§14)", () => {
  it("prisma migrate status reports no pending migrations after migrate deploy", () => {
    const output = execFileSync("pnpm", ["exec", "prisma", "migrate", "status"], {
      cwd: DB_PACKAGE_DIR,
      env: process.env,
      encoding: "utf-8",
    });
    expect(output).toContain("Database schema is up to date");
  });

  it("round-trips a User and a Project insert", async () => {
    const user = await prisma.user.create({ data: {} });
    expect(user.id).toBeTruthy();
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);

    const project = await prisma.project.create({ data: { userId: user.id } });
    expect(project.id).toBeTruthy();
    expect(project.userId).toBe(user.id);

    const fetchedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const fetchedProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(fetchedUser.id).toBe(user.id);
    expect(fetchedProject.userId).toBe(user.id);
  });

  it("has only the placeholder columns — no premature schema creep", async () => {
    const userColumns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'User' ORDER BY column_name;`,
    );
    expect(userColumns.map((c) => c.column_name).sort()).toEqual(["createdAt", "id", "updatedAt"]);

    const projectColumns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'Project' ORDER BY column_name;`,
    );
    expect(projectColumns.map((c) => c.column_name).sort()).toEqual(["createdAt", "id", "updatedAt", "userId"]);
  });
});
