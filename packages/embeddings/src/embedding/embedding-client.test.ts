import type { Logger } from "@repo/observability";
import { EMBEDDING_BATCH_SIZE } from "@repo/shared";
import { describe, expect, it } from "vitest";
import { embedMany, type EmbedItem } from "./embedding-client.js";
import {
  EmbeddingDimensionMismatchError,
  EmbeddingProviderHttpError,
  type EmbeddingProvider,
} from "./provider.js";

// Claude.md §30: no test here ever calls a real embedding provider — every provider in
// this file is a scripted in-memory fake.

class ScriptedProvider implements EmbeddingProvider {
  readonly model = "test-model";
  readonly dimensions = 4;
  readonly calls: string[][] = [];

  constructor(
    private readonly handler: (
      texts: readonly string[],
      callIndex: number,
    ) => number[][],
  ) {}

  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    const callIndex = this.calls.length;
    this.calls.push([...texts]);
    return this.handler(texts, callIndex);
  }
}

function fakeVectors(count: number): number[][] {
  return Array.from({ length: count }, (_, i) => [i, i, i, i]);
}

function items(n: number): EmbedItem[] {
  return Array.from({ length: n }, (_, i) => ({
    contentHash: `hash-${String(i)}`,
    text: `text-${String(i)}`,
  }));
}

function noDelay(): Promise<void> {
  return Promise.resolve();
}

function recordingLogger(): {
  logger: Logger;
  records: { level: string; msg: string; fields?: Record<string, unknown> }[];
} {
  const records: {
    level: string;
    msg: string;
    fields?: Record<string, unknown>;
  }[] = [];
  const logger: Logger = {
    debug: (msg, fields) => records.push({ level: "debug", msg, fields }),
    info: (msg, fields) => records.push({ level: "info", msg, fields }),
    warn: (msg, fields) => records.push({ level: "warn", msg, fields }),
    error: (msg, fields) => records.push({ level: "error", msg, fields }),
  };
  return { logger, records };
}

describe("embedMany", () => {
  it("makes exactly ceil(n/EMBEDDING_BATCH_SIZE) provider calls when every batch succeeds", async () => {
    const n = EMBEDDING_BATCH_SIZE * 2 + 5;
    const provider = new ScriptedProvider((texts) => fakeVectors(texts.length));
    const result = await embedMany(provider, items(n), { sleep: noDelay });

    expect(provider.calls).toHaveLength(Math.ceil(n / EMBEDDING_BATCH_SIZE));
    expect(result.embedded.size).toBe(n);
    expect(result.failed).toEqual([]);
    expect(result.attempts).toBe(Math.ceil(n / EMBEDDING_BATCH_SIZE));
  });

  it("halves the batch on attempt 2 after a 429 on attempt 1", async () => {
    const provider = new ScriptedProvider((texts, callIndex) => {
      if (callIndex === 0) {
        throw new EmbeddingProviderHttpError("rate limited", 429);
      }
      return fakeVectors(texts.length);
    });
    const result = await embedMany(provider, items(EMBEDDING_BATCH_SIZE), {
      sleep: noDelay,
    });

    expect(provider.calls[0]).toHaveLength(EMBEDDING_BATCH_SIZE);
    expect(provider.calls[1]).toHaveLength(Math.ceil(EMBEDDING_BATCH_SIZE / 2));
    expect(provider.calls[2]).toHaveLength(
      Math.floor(EMBEDDING_BATCH_SIZE / 2),
    );
    expect(result.failed).toEqual([]);
    expect(result.embedded.size).toBe(EMBEDDING_BATCH_SIZE);
  });

  it("exhausts four attempts and returns a partial result with the right failed list — never throws", async () => {
    const provider = new ScriptedProvider(() => {
      throw new EmbeddingProviderHttpError("always unavailable", 503);
    });
    const input = items(EMBEDDING_BATCH_SIZE);

    const result = await embedMany(provider, input, { sleep: noDelay });

    expect(result.embedded.size).toBe(0);
    expect(new Set(result.failed)).toEqual(
      new Set(input.map((i) => i.contentHash)),
    );
    // 1 (size 96) + 2 (size 48) + 4 (size 24) + 8 (size 12) = 15 calls total.
    expect(result.attempts).toBe(15);
  });

  it("fails a 401 immediately, with no retry", async () => {
    const provider = new ScriptedProvider(() => {
      throw new EmbeddingProviderHttpError("unauthorized", 401);
    });
    const input = items(10);
    const result = await embedMany(provider, input, { sleep: noDelay });

    expect(provider.calls).toHaveLength(1);
    expect(result.failed).toEqual(input.map((i) => i.contentHash));
    expect(result.embedded.size).toBe(0);
  });

  it("fails a dimension mismatch immediately, with no retry", async () => {
    const provider = new ScriptedProvider(() => {
      throw new EmbeddingDimensionMismatchError("199 vectors for 200 inputs");
    });
    const input = items(5);
    const result = await embedMany(provider, input, { sleep: noDelay });

    expect(provider.calls).toHaveLength(1);
    expect(result.failed).toEqual(input.map((i) => i.contentHash));
  });

  it("logs one line per batch call with batch size, attempt, latency, and cache-hit count — never the texts or vectors", async () => {
    const provider = new ScriptedProvider((texts) => fakeVectors(texts.length));
    const { logger, records } = recordingLogger();

    await embedMany(provider, items(3), {
      sleep: noDelay,
      logger,
      cacheHitCount: 12,
    });

    expect(records).toHaveLength(1);
    const [line] = records;
    expect(line!.level).toBe("info");
    expect(line!.fields).toMatchObject({
      batchSize: 3,
      attempt: 1,
      cacheHitCount: 12,
      model: "test-model",
    });
    expect(typeof line!.fields?.latencyMs).toBe("number");
    expect(JSON.stringify(line!.fields)).not.toContain("text-0");
    expect(JSON.stringify(line!.fields)).not.toContain("[0,0,0,0]");
  });
});
