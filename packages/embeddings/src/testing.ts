import { createHash } from "node:crypto";
import { EMBEDDING_DIMENSIONS } from "@repo/shared";
import type { EmbeddingProvider } from "./embedding/provider.js";

/**
 * Phase 05 prompt 3, sub-task 3.8 / §2.3: the injected `EmbeddingProvider` test double.
 * Lives behind the `./testing` subpath (this package's `exports` map — see package.json)
 * rather than the main barrel, so production code cannot accidentally import a fake
 * instead of `createEmbeddingProvider`. Every test in this package and its consumers
 * (apps/worker, apps/api) uses this, never a real provider — Claude.md §30 is explicit
 * that no test may call a real embedding provider.
 *
 * Vectors are deterministic pseudo-embeddings derived from a sha256 hash of the input
 * text: the same text always produces the same vector (needed for cache-hit tests —
 * sub-task 3.7's own "identical content produces exactly one provider call" test would
 * be meaningless against a provider whose output changes call to call), and different
 * texts produce different vectors (needed for any test that checks embeddings actually
 * distinguish content, e.g. a retrieval-ordering test in a later phase). No claim is
 * made that these vectors carry any real semantic meaning — they exist to exercise the
 * pipeline's plumbing (batching, caching, dimension checks), not to be embedded search
 * quality fixtures.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  constructor(options: { model?: string; dimensions?: number } = {}) {
    this.model = options.model ?? "fake-embedding-model";
    this.dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
  }

  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => this.deterministicVector(text));
  }

  private deterministicVector(text: string): number[] {
    const digest = createHash("sha256").update(text, "utf8").digest();
    return Array.from({ length: this.dimensions }, (_, i) => {
      const byte = digest[i % digest.length]!;
      // Normalized to roughly [-1, 1] — a plausible embedding-magnitude range, not that
      // it matters for a fake whose only job is determinism plus distinguishability.
      return byte / 127.5 - 1;
    });
  }
}
