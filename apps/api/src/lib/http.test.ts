import { Writable } from "node:stream";
import express, { type Express } from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "./errors.js";
import { createRequestContext, errorHandler, requestContext, withRoute } from "./http.js";

function buildTestApp(context = requestContext): Express {
  const app = express();
  app.use(context);

  app.get(
    "/ok",
    withRoute(
      async (_req, res) => {
        res.json({ ok: true });
      },
      { component: "test.ok" },
    ),
  );

  app.get(
    "/validation-error",
    withRoute(
      () => {
        throw new ValidationError("bad input", { details: { fieldErrors: { name: ["required"] } } });
      },
      { component: "test.validation" },
    ),
  );

  app.get(
    "/boom",
    withRoute(
      () => {
        throw new Error("unexpected failure with a secret stack frame");
      },
      { component: "test.boom" },
    ),
  );

  app.get(
    "/async-boom",
    withRoute(
      async () => {
        await Promise.resolve();
        throw new Error("async unexpected failure");
      },
      { component: "test.asyncBoom" },
    ),
  );

  app.use((req, _res, next) => next(new NotFoundError(`Route ${req.method} ${req.originalUrl} not found`)));
  app.use(errorHandler);
  return app;
}

describe("requestContext + withRoute + errorHandler", () => {
  it("returns 200 and stamps an x-trace-id header for a successful route", async () => {
    const res = await request(buildTestApp()).get("/ok");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["x-trace-id"]).toBeTruthy();
  });

  it("seeds the trace id from an inbound x-trace-id header instead of generating one", async () => {
    const res = await request(buildTestApp()).get("/ok").set("x-trace-id", "seeded-trace-id");
    expect(res.headers["x-trace-id"]).toBe("seeded-trace-id");
  });

  it("serializes a thrown AppError to its declared status and the standard envelope", async () => {
    const res = await request(buildTestApp()).get("/validation-error");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "bad input",
        details: { fieldErrors: { name: ["required"] } },
      },
    });
  });

  it("converts an unknown throw to a generic INTERNAL_ERROR 500 without leaking the stack", async () => {
    const res = await request(buildTestApp()).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error", details: {} },
    });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("unexpected failure");
    expect(raw).not.toContain(".ts:");
  });

  it("catches a rejected async handler the same way as a synchronous throw", async () => {
    const res = await request(buildTestApp()).get("/async-boom");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("renders unmatched routes as a 404 NOT_FOUND envelope", async () => {
    const res = await request(buildTestApp()).get("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("emits exactly one structured log line per request, carrying traceId/component/durationMs (FR2)", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, callback) {
        lines.push(JSON.parse(chunk.toString()));
        callback();
      },
    });
    const instance = pino(
      { level: "debug", base: null, timestamp: false, messageKey: "msg", formatters: { level: (label) => ({ level: label }) } },
      stream,
    );

    const res = await request(buildTestApp(createRequestContext(instance))).get("/ok");

    expect(res.status).toBe(200);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", msg: "request completed", component: "test.ok", statusCode: 200 });
    expect(typeof lines[0]?.traceId).toBe("string");
    expect(typeof lines[0]?.durationMs).toBe("number");
  });

  it("escalates the single log line to error level and attaches the stack on a failed request", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, callback) {
        lines.push(JSON.parse(chunk.toString()));
        callback();
      },
    });
    const instance = pino(
      { level: "debug", base: null, timestamp: false, messageKey: "msg", formatters: { level: (label) => ({ level: label }) } },
      stream,
    );

    await request(buildTestApp(createRequestContext(instance))).get("/boom");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "error", msg: "request failed", component: "test.boom", statusCode: 500, code: "INTERNAL_ERROR" });
    expect(typeof lines[0]?.stack).toBe("string");
  });
});
