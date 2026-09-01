import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS } from "@repo/shared";
import { FakeEmbeddingProvider } from "./testing.js";

describe("FakeEmbeddingProvider", () => {
  it("returns EMBEDDING_DIMENSIONS-length vectors by default", async () => {
    const provider = new FakeEmbeddingProvider();
    const [vector] = await provider.embedBatch(["hello"]);
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("is deterministic — the same text always produces the same vector", async () => {
    const provider = new FakeEmbeddingProvider();
    const [a] = await provider.embedBatch(["identical content"]);
    const [b] = await provider.embedBatch(["identical content"]);
    expect(b).toEqual(a);
  });

  it("produces different vectors for different text", async () => {
    const provider = new FakeEmbeddingProvider();
    const [a, b] = await provider.embedBatch(["text one", "text two"]);
    expect(a).not.toEqual(b);
  });

  it("respects a custom dimensions option", async () => {
    const provider = new FakeEmbeddingProvider({ dimensions: 8 });
    const [vector] = await provider.embedBatch(["x"]);
    expect(vector).toHaveLength(8);
  });
});
