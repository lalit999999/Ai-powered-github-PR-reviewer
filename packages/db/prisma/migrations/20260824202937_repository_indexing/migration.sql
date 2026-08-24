-- CreateEnum
CREATE TYPE "FileClassification" AS ENUM ('SOURCE', 'TEST', 'CONFIG', 'GENERATED', 'DEPENDENCY_LOCK', 'DOCUMENTATION', 'ASSET', 'UNKNOWN');

-- CreateTable
CREATE TABLE "RepositoryFile" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "language" TEXT,
    "contentHash" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "packageName" TEXT,
    "classification" "FileClassification" NOT NULL DEFAULT 'UNKNOWN',
    "indexState" TEXT NOT NULL DEFAULT 'INDEXED',
    "skipReason" TEXT,
    "parseState" TEXT NOT NULL DEFAULT 'OK',
    "symbolCount" INTEGER NOT NULL DEFAULT 0,
    "inboundEdgeCount" INTEGER NOT NULL DEFAULT 0,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "isGenerated" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepositoryFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexJob" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "targetCommitSha" TEXT,
    "previousCommitSha" TEXT,
    "inngestRunId" TEXT,
    "filesTotal" INTEGER NOT NULL DEFAULT 0,
    "filesProcessed" INTEGER NOT NULL DEFAULT 0,
    "filesSkipped" INTEGER NOT NULL DEFAULT 0,
    "symbolsCreated" INTEGER NOT NULL DEFAULT 0,
    "edgesCreated" INTEGER NOT NULL DEFAULT 0,
    "chunksEmbedded" INTEGER NOT NULL DEFAULT 0,
    "embeddingCacheHits" INTEGER NOT NULL DEFAULT 0,
    "currentStep" TEXT,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "error" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndexJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RepositoryFile_repositoryId_contentHash_idx" ON "RepositoryFile"("repositoryId", "contentHash");

-- CreateIndex
CREATE INDEX "RepositoryFile_repositoryId_packageName_idx" ON "RepositoryFile"("repositoryId", "packageName");

-- CreateIndex
CREATE INDEX "RepositoryFile_repositoryId_indexState_idx" ON "RepositoryFile"("repositoryId", "indexState");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryFile_repositoryId_path_key" ON "RepositoryFile"("repositoryId", "path");

-- CreateIndex
CREATE INDEX "IndexJob_repositoryId_createdAt_idx" ON "IndexJob"("repositoryId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "IndexJob_status_idx" ON "IndexJob"("status");

-- AddForeignKey
ALTER TABLE "RepositoryFile" ADD CONSTRAINT "RepositoryFile_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndexJob" ADD CONSTRAINT "IndexJob_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
