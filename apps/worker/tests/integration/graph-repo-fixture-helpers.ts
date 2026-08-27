import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "@repo/observability";
import {
  buildKnowledgeGraph,
  type GraphBuilderResult,
} from "../../src/indexing/graph/graph-builder.js";
import {
  buildRepoContext,
  type RepoContext,
} from "../../src/indexing/graph/repo-context.js";
import { countInboundEdgesByFile } from "../../src/indexing/persistence/code-dependency.repository.js";
import {
  findRepositoryFilesByCommit,
  updateRepositoryFileGraphMetadata,
  upsertRepositoryFiles,
  type RepositoryFileGraphMetadataUpdate,
} from "../../src/indexing/persistence/repository-file.repository.js";
import { walkTree } from "../../src/indexing/walk-tree.js";
import { seedRepository, type SeededRepository } from "./repository-helpers.js";

/**
 * Prompt 5, sub-tasks 5.1/5.2: runs the **real** pipeline (walk → persist RepositoryFile
 * rows → build repo context → build the knowledge graph) directly against the committed
 * `tests/fixtures/graph-repo/` source tree — no tarball, no temp-directory copy, since the
 * fixture already lives on disk exactly where a real extracted repository would. Both the
 * structural test (`graph-fixture.test.ts`) and the precision measurement
 * (`call-precision.test.ts`) share this so neither can silently drift from what the other
 * actually indexed.
 */

export const GRAPH_REPO_FIXTURE_ROOT = path.resolve(
  fileURLToPath(new URL("../fixtures/graph-repo/", import.meta.url)),
);

export const GRAPH_REPO_COMMIT_SHA = "graphrepofixturesha1";

export interface GraphRepoFixtureResult {
  repository: SeededRepository;
  repoContext: RepoContext;
  graph: GraphBuilderResult;
}

function noopLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}

/**
 * Seeds a fresh `Repository` row and runs the real pipeline against
 * {@link GRAPH_REPO_FIXTURE_ROOT}. Each call seeds its own repository (via
 * `repository-helpers.ts`'s own auto-incrementing sequence) so tests can run this more
 * than once (e.g. re-running pass 2 to prove no duplicate edges) without colliding.
 */
export async function indexGraphRepoFixture(): Promise<GraphRepoFixtureResult> {
  const repository = await seedRepository();
  const logger = noopLogger();

  const walked = await walkTree(GRAPH_REPO_FIXTURE_ROOT, { logger });

  await upsertRepositoryFiles(
    walked.files.map((file) => ({
      repositoryId: repository.id,
      path: file.path,
      commitSha: GRAPH_REPO_COMMIT_SHA,
      language: file.language,
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes,
      lineCount: file.lineCount,
      packageName: file.packageName,
      classification: file.classification,
      indexState: file.indexState,
      skipReason: file.skipReason,
      isTest: file.isTest,
      isGenerated: file.isGenerated,
    })),
  );

  const persistedFiles = await findRepositoryFilesByCommit(
    repository.id,
    GRAPH_REPO_COMMIT_SHA,
  );
  const repoContext = await buildRepoContext(
    GRAPH_REPO_FIXTURE_ROOT,
    walked.files.map((file) => file.path),
  );

  const graph = await buildKnowledgeGraph({
    rootDir: GRAPH_REPO_FIXTURE_ROOT,
    files: persistedFiles,
    repoContext,
    repositoryId: repository.id,
    commitSha: GRAPH_REPO_COMMIT_SHA,
    attempt: 0,
    logger,
  });

  // Mirrors indexer.service.ts's own onExtracted callback exactly — without this, the
  // RepositoryFile columns this suite's structural assertions check
  // (parseState/symbolCount/inboundEdgeCount/packageName/isTest) would sit at their
  // pre-graph defaults forever, since buildKnowledgeGraph itself never writes them.
  const inboundCounts = await countInboundEdgesByFile(repository.id);
  const inboundByFileId = new Map(
    inboundCounts.map((row) => [row.fileId, row.inboundEdgeCount]),
  );
  const metadataUpdates: RepositoryFileGraphMetadataUpdate[] =
    graph.fileGraphMetadata.map((meta) => ({
      fileId: meta.fileId,
      symbolCount: meta.symbolCount,
      inboundEdgeCount: inboundByFileId.get(meta.fileId) ?? 0,
      parseState: meta.parseState,
      packageName: meta.packageName,
      isTest: meta.isTest,
    }));
  await updateRepositoryFileGraphMetadata(metadataUpdates);

  return { repository, repoContext, graph };
}
