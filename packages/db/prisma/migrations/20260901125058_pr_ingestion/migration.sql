-- Hand-edited (phase-07 prompt-1 sub-task 1.4). Prisma's shadow-database drift check
-- proposed four statements here that this migration must never run, all for the
-- identical reason the phase-05 `vector_search` migration's own header comment already
-- names: `CodeDependency.kind`'s hand-written `NULLS NOT DISTINCT` unique constraint and
-- `CodeChunk`'s `tsv`/`embedding` raw-SQL columns and indexes have no schema.prisma
-- declaration to reconcile a diff against (Prisma's schema language cannot express any
-- of the three), so every migration computed by `prisma migrate dev` from here on
-- proposes re-dropping them until the day a real migration intentionally changes one.
-- Removed, exactly as `vector_search`'s own migration.sql already removed the first of
-- these once before:
--   DROP INDEX "CodeChunk_embedding_hnsw_idx";
--   DROP INDEX "CodeChunk_tsv_gin_idx";
--   DROP INDEX "CodeDependency_edge_identity_key";
--   ALTER TABLE "CodeChunk" ALTER COLUMN "tsv" DROP DEFAULT;
-- See `CodeDependency`'s and `CodeChunk`'s own model comments in schema.prisma, and
-- docs/decisions/phase-04-log.md. Use `prisma migrate status` to check pending
-- migrations and `prisma migrate deploy` to apply them — never accept a `prisma migrate
-- dev` prompt that proposes touching any of the four statements above.

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'WAITING_FOR_INDEX', 'RUNNING', 'AGGREGATING', 'PUBLISHING', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ReviewDepth" AS ENUM ('DEEP', 'SHALLOW', 'SKIP');

-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN     "additions" INTEGER,
ADD COLUMN     "authorAvatarUrl" TEXT,
ADD COLUMN     "authorLogin" TEXT,
ADD COLUMN     "baseRef" TEXT,
ADD COLUMN     "baseSha" TEXT,
ADD COLUMN     "body" TEXT,
ADD COLUMN     "changedFileCount" INTEGER,
ADD COLUMN     "deletions" INTEGER,
ADD COLUMN     "githubCreatedAt" TIMESTAMP(3),
ADD COLUMN     "githubUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "headRef" TEXT,
ADD COLUMN     "htmlUrl" TEXT,
ADD COLUMN     "latestReviewId" TEXT,
ADD COLUMN     "title" TEXT;

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "trigger" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "contextQuality" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedCostCents" INTEGER,
    "error" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequestFile" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "previousPath" TEXT,
    "status" TEXT NOT NULL,
    "additions" INTEGER NOT NULL,
    "deletions" INTEGER NOT NULL,
    "changes" INTEGER NOT NULL,
    "sha" TEXT,
    "patchRef" TEXT,
    "patchBytes" INTEGER NOT NULL DEFAULT 0,
    "classification" "FileClassification" NOT NULL DEFAULT 'UNKNOWN',
    "depth" "ReviewDepth" NOT NULL,
    "priorityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviewStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "isOversized" BOOLEAN NOT NULL DEFAULT false,
    "diffPositionMap" JSONB,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PullRequestFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewJob" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "pullRequestFileId" TEXT,
    "inngestRunId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatchBlob" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatchBlob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Review_idempotencyKey_key" ON "Review"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Review_pullRequestId_createdAt_idx" ON "Review"("pullRequestId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Review_projectId_createdAt_idx" ON "Review"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Review_status_idx" ON "Review"("status");

-- CreateIndex
CREATE INDEX "PullRequestFile_reviewId_reviewStatus_idx" ON "PullRequestFile"("reviewId", "reviewStatus");

-- CreateIndex
CREATE INDEX "PullRequestFile_reviewId_priorityScore_idx" ON "PullRequestFile"("reviewId", "priorityScore" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PullRequestFile_reviewId_path_key" ON "PullRequestFile"("reviewId", "path");

-- CreateIndex
CREATE INDEX "ReviewJob_reviewId_kind_idx" ON "ReviewJob"("reviewId", "kind");

-- CreateIndex
CREATE INDEX "PatchBlob_reviewId_idx" ON "PatchBlob"("reviewId");

-- CreateIndex
CREATE UNIQUE INDEX "PatchBlob_reviewId_path_key" ON "PatchBlob"("reviewId", "path");

-- CreateIndex
CREATE INDEX "PullRequest_repositoryId_githubUpdatedAt_idx" ON "PullRequest"("repositoryId", "githubUpdatedAt" DESC);

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequestFile" ADD CONSTRAINT "PullRequestFile_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewJob" ADD CONSTRAINT "ReviewJob_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatchBlob" ADD CONSTRAINT "PatchBlob_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;
