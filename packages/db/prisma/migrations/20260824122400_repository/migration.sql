-- CreateEnum
CREATE TYPE "IndexStatus" AS ENUM ('PENDING', 'INDEXING', 'INDEXED', 'UPDATING', 'FAILED', 'PARTIAL');

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "githubRepoId" BIGINT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "isPrivate" BOOLEAN NOT NULL DEFAULT true,
    "htmlUrl" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "webhookId" BIGINT,
    "connectionStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "indexStatus" "IndexStatus" NOT NULL DEFAULT 'PENDING',
    "indexedCommitSha" TEXT,
    "indexVersion" INTEGER NOT NULL DEFAULT 1,
    "indexedFileCount" INTEGER NOT NULL DEFAULT 0,
    "skippedFileCount" INTEGER NOT NULL DEFAULT 0,
    "reviewProfile" TEXT,
    "lastIndexedAt" TIMESTAMP(3),
    "indexError" JSONB,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Repository_githubRepoId_idx" ON "Repository"("githubRepoId");

-- CreateIndex
CREATE INDEX "Repository_indexStatus_idx" ON "Repository"("indexStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_projectId_githubRepoId_key" ON "Repository"("projectId", "githubRepoId");

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
