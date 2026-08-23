import { prisma } from "@repo/db";
import request from "supertest";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import * as healthRepository from "../../src/modules/health/health.repository.js";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/health (phase-00 §7/§14)", () => {
  it("returns 200 with a traceId against a live database", async () => {
    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", traceId: expect.any(String) });
    expect(res.headers["x-trace-id"]).toBe(res.body.traceId);
  });

  it("returns 503 with the DB_UNAVAILABLE envelope when the database is unreachable", async () => {
    // Spies on the repository export, not prisma.$queryRaw directly: verified
    // empirically that vi.spyOn on the Prisma 7 driver-adapter client's own methods
    // does not restore correctly afterwards (it leaves $queryRaw permanently broken
    // for the rest of the worker process, breaking every later integration test that
    // shares it under vitest.integration.config.ts's fileParallelism:false) — see
    // docs/decisions/phase-01-log.md. Spying one layer up, on this module's own
    // plain async export, reproduces the same failure path without that hazard.
    vi.spyOn(healthRepository, "pingDatabase").mockRejectedValueOnce(new Error("connection refused"));

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: { code: "DB_UNAVAILABLE", message: "Database unavailable", details: {} },
    });
  });

  it("reveals no internal detail beyond status and traceId", async () => {
    const res = await request(app).get("/api/health");

    expect(Object.keys(res.body).sort()).toEqual(["status", "traceId"]);
  });
});
