import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createLogger, redact } from "./logger.js";
import { runWithTraceContext } from "./tracing.js";

function createCapturingLogger(component: string) {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      lines.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  const instance = pino(
    {
      level: "debug",
      base: null,
      timestamp: false,
      messageKey: "msg",
      formatters: { level: (label) => ({ level: label }) },
    },
    stream,
  );
  return { logger: createLogger(component, instance), lines };
}

describe("createLogger", () => {
  it("emits the phase-00 §20 envelope shape", () => {
    const { logger, lines } = createCapturingLogger("test.component");
    logger.info("hello world");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", msg: "hello world", component: "test.component" });
    expect(typeof lines[0]?.ts).toBe("string");
    expect(() => new Date(lines[0]?.ts as string).toISOString()).not.toThrow();
  });

  it("carries traceId when emitted inside a trace context", () => {
    const { logger, lines } = createCapturingLogger("test.component");
    runWithTraceContext({ traceId: "01TESTTRACE" }, () => {
      logger.info("inside context");
    });
    expect(lines[0]?.traceId).toBe("01TESTTRACE");
  });

  it("has no traceId outside a trace context", () => {
    const { logger, lines } = createCapturingLogger("test.component");
    logger.info("outside context");
    expect(lines[0]?.traceId).toBeUndefined();
  });

  it("redacts DATABASE_URL and every *_KEY/_SECRET/_TOKEN key through a real emitted line", () => {
    const { logger, lines } = createCapturingLogger("test.component");
    logger.info("boot", {
      DATABASE_URL: "postgres://user:pass@host/db",
      API_KEY: "sk-123",
      GITHUB_PRIVATE_KEY: "----BEGIN----",
      SESSION_SECRET: "shh",
      INNGEST_SIGNING_KEY: "signkey",
      ACCESS_TOKEN: "tok",
      nested: { STRIPE_SECRET: "sk_live_x", safe: "kept" },
      safeValue: "kept-too",
    });

    const line = lines[0] as Record<string, unknown>;
    expect(line.DATABASE_URL).toBe("[REDACTED]");
    expect(line.API_KEY).toBe("[REDACTED]");
    expect(line.GITHUB_PRIVATE_KEY).toBe("[REDACTED]");
    expect(line.SESSION_SECRET).toBe("[REDACTED]");
    expect(line.INNGEST_SIGNING_KEY).toBe("[REDACTED]");
    expect(line.ACCESS_TOKEN).toBe("[REDACTED]");
    expect((line.nested as Record<string, unknown>).STRIPE_SECRET).toBe("[REDACTED]");
    expect((line.nested as Record<string, unknown>).safe).toBe("kept");
    expect(line.safeValue).toBe("kept-too");
  });
});

describe("redact (pure function)", () => {
  it("leaves non-matching keys untouched and redacts matching keys at any depth", () => {
    const output = redact({
      DATABASE_URL: "secret",
      ok: "fine",
      deep: { deeper: { AUTH_TOKEN: "secret", ok: "fine" } },
      list: [{ CLIENT_SECRET: "secret" }, { ok: "fine" }],
    }) as Record<string, unknown>;

    expect(output.DATABASE_URL).toBe("[REDACTED]");
    expect(output.ok).toBe("fine");
    expect((output.deep as never as { deeper: Record<string, unknown> }).deeper.AUTH_TOKEN).toBe("[REDACTED]");
    expect((output.deep as never as { deeper: Record<string, unknown> }).deeper.ok).toBe("fine");
    const list = output.list as Record<string, unknown>[];
    expect(list[0]?.CLIENT_SECRET).toBe("[REDACTED]");
    expect(list[1]?.ok).toBe("fine");
  });

  it("leaves primitives, null, and Date instances alone", () => {
    const date = new Date();
    expect(redact("plain string")).toBe("plain string");
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
    expect(redact(date)).toBe(date);
  });
});
