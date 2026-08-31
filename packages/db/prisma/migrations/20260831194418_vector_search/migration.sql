-- Hand-edited (phase-05 prompt-1 sub-task 1.6). Prisma's schema language cannot express
-- pgvector types, generated columns, or HNSW/GIN index methods; the Unsupported(...)
-- fields in schema.prisma keep the two columns visible to the migration engine, but
-- everything below is written by hand. Do NOT `prisma db push` against this schema, and
-- do NOT accept a `prisma migrate dev` prompt that proposes dropping any of it — use
-- `prisma migrate status` to check and `prisma migrate deploy` to apply.

-- Must run before any CREATE TABLE that uses the halfvec type below.
CREATE EXTENSION IF NOT EXISTS vector;

-- Hand-edited (phase-05 prompt-1 sub-task 1.6). Prisma's shadow-database drift check
-- generated a `DROP INDEX "CodeDependency_edge_identity_key"` here, because that
-- constraint is hand-written NULLS NOT DISTINCT SQL with no @@unique declaration in
-- schema.prisma to reconcile against — exactly the hazard CodeDependency's own model
-- comment and docs/decisions/phase-04-log.md warn about. Removed; this migration must
-- never drop that constraint.

-- CreateTable
CREATE TABLE "CodeChunk" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "symbolId" TEXT,
    "commitSha" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "packageName" TEXT,
    "language" TEXT NOT NULL,
    "chunkKind" TEXT NOT NULL,
    "startLine" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "symbols" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "imports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenCount" INTEGER NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "embedding" halfvec(1024),
    -- "tsv" is added below as a GENERATED ALWAYS AS ... STORED column, not declared
    -- here — Prisma's own CREATE TABLE would otherwise create it as a plain writable
    -- column, which the ALTER TABLE ADD COLUMN below cannot then convert in place.

    CONSTRAINT "CodeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmbeddingCache" (
    "contentHash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "embedding" halfvec(1024),

    CONSTRAINT "EmbeddingCache_pkey" PRIMARY KEY ("contentHash")
);

-- CreateIndex
CREATE INDEX "CodeChunk_repositoryId_commitSha_idx" ON "CodeChunk"("repositoryId", "commitSha");

-- CreateIndex
CREATE INDEX "CodeChunk_repositoryId_filePath_idx" ON "CodeChunk"("repositoryId", "filePath");

-- CreateIndex
CREATE UNIQUE INDEX "CodeChunk_repositoryId_contentHash_startLine_filePath_key" ON "CodeChunk"("repositoryId", "contentHash", "startLine", "filePath");

-- CreateIndex
CREATE INDEX "EmbeddingCache_lastUsedAt_idx" ON "EmbeddingCache"("lastUsedAt");

-- AddForeignKey
ALTER TABLE "CodeChunk" ADD CONSTRAINT "CodeChunk_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeChunk" ADD CONSTRAINT "CodeChunk_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "RepositoryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeChunk" ADD CONSTRAINT "CodeChunk_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "CodeSymbol"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The generated tsvector column. `to_tsvector(regconfig, text)` — the TWO-argument form
-- with an explicit config literal — is IMMUTABLE and therefore legal in a generated
-- column. The one-argument `to_tsvector(text)` is only STABLE (it reads
-- default_text_search_config) and Postgres will reject it here. Do not "simplify" this.
ALTER TABLE "CodeChunk"
  ADD COLUMN "tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED;

-- §4 Technical Requirements / plan.md §12.3: HNSW over halfvec with cosine distance.
CREATE INDEX "CodeChunk_embedding_hnsw_idx"
  ON "CodeChunk" USING hnsw ("embedding" halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- The lexical half of hybrid search, in the same table as the vectors — the specific
-- advantage of pgvector over a second stateful system (plan.md §1.3 change ①).
CREATE INDEX "CodeChunk_tsv_gin_idx" ON "CodeChunk" USING gin ("tsv");

-- The resume-embedding sweeper's scan (§8). Without this, finding the unembedded
-- remainder of a PARTIAL repository is a sequential scan of every chunk it has.
CREATE INDEX "CodeChunk_pending_embedding_idx"
  ON "CodeChunk" ("repositoryId")
  WHERE "embedding" IS NULL;
