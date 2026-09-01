import { describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIMENSIONS } from "@repo/shared";
import {
  EmbeddingDimensionMismatchError,
  EmbeddingProviderHttpError,
  EmbeddingProviderShapeError,
  RealEmbeddingProvider,
} from "./provider.js";

// Claude.md §30: no test may call a real embedding provider — every test here injects a
// fake `fetchImpl` and never opens a socket.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeVector(dimensions: number, seed: number): number[] {
  return Array.from({ length: dimensions }, (_, i) => (i + seed) / 1000);
}

describe("RealEmbeddingProvider", () => {
  it("posts input/model/output_dimension and returns vectors in input order", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          input: string[];
          model: string;
        };
        expect(body.model).toBe("voyage-code-3");
        expect(body.input).toEqual(["a", "b"]);
        return jsonResponse(200, {
          model: "voyage-code-3",
          data: [
            { embedding: fakeVector(EMBEDDING_DIMENSIONS, 2), index: 1 },
            { embedding: fakeVector(EMBEDDING_DIMENSIONS, 1), index: 0 },
          ],
        });
      },
    );

    const provider = new RealEmbeddingProvider({
      apiKey: "test-key",
      model: "voyage-code-3",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const vectors = await provider.embedBatch(["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual(fakeVector(EMBEDDING_DIMENSIONS, 1));
    expect(vectors[1]).toEqual(fakeVector(EMBEDDING_DIMENSIONS, 2));
  });

  it("never logs the api key, and sends it only as the bearer token", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer super-secret-key");
        return jsonResponse(200, {
          model: "voyage-code-3",
          data: [{ embedding: fakeVector(EMBEDDING_DIMENSIONS, 0), index: 0 }],
        });
      },
    );
    const provider = new RealEmbeddingProvider({
      apiKey: "super-secret-key",
      model: "voyage-code-3",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.embedBatch(["x"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws EmbeddingProviderHttpError on a non-2xx response, carrying the status", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, { error: "rate limited" }),
    );
    const provider = new RealEmbeddingProvider({
      apiKey: "k",
      model: "voyage-code-3",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.embedBatch(["x"])).rejects.toMatchObject({
      status: 429,
    });
    await expect(provider.embedBatch(["x"])).rejects.toBeInstanceOf(
      EmbeddingProviderHttpError,
    );
  });

  it("rejects a response whose data array is shorter than the input (silent misalignment risk)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        model: "voyage-code-3",
        data: [{ embedding: fakeVector(EMBEDDING_DIMENSIONS, 0), index: 0 }],
      }),
    );
    const provider = new RealEmbeddingProvider({
      apiKey: "k",
      model: "voyage-code-3",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.embedBatch(["a", "b"])).rejects.toBeInstanceOf(
      EmbeddingDimensionMismatchError,
    );
  });

  it("rejects a vector whose dimension does not match EMBEDDING_DIMENSIONS", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        model: "voyage-code-3",
        data: [{ embedding: [1, 2, 3], index: 0 }],
      }),
    );
    const provider = new RealEmbeddingProvider({
      apiKey: "k",
      model: "voyage-code-3",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.embedBatch(["a"])).rejects.toBeInstanceOf(
      EmbeddingDimensionMismatchError,
    );
  });

  it("rejects a response that fails Zod shape validation entirely", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { unexpected: "shape" }),
    );
    const provider = new RealEmbeddingProvider({
      apiKey: "k",
      model: "voyage-code-3",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.embedBatch(["a"])).rejects.toBeInstanceOf(
      EmbeddingProviderShapeError,
    );
  });
});
