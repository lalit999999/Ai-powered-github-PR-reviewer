-- CreateEnum
CREATE TYPE "DependencyKind" AS ENUM ('IMPORTS', 'EXPORTS', 'CONTAINS', 'CALLS', 'EXTENDS', 'IMPLEMENTS', 'REFERENCES', 'TESTS');

-- CreateTable
CREATE TABLE "CodeSymbol" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "startLine" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "isExported" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "signature" TEXT,
    "docComment" TEXT,
    "parentSymbolId" TEXT,
    "complexity" INTEGER NOT NULL DEFAULT 0,
    "commitSha" TEXT NOT NULL,

    CONSTRAINT "CodeSymbol_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeDependency" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "kind" "DependencyKind" NOT NULL,
    "fromFileId" TEXT,
    "toFileId" TEXT,
    "fromSymbolId" TEXT,
    "toSymbolId" TEXT,
    "externalPackage" TEXT,
    "rawSpecifier" TEXT,
    "resolution" TEXT NOT NULL DEFAULT 'RESOLVED',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "commitSha" TEXT NOT NULL,

    CONSTRAINT "CodeDependency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CodeSymbol_fileId_idx" ON "CodeSymbol"("fileId");

-- CreateIndex
CREATE INDEX "CodeSymbol_repositoryId_name_idx" ON "CodeSymbol"("repositoryId", "name");

-- CreateIndex
CREATE INDEX "CodeSymbol_repositoryId_isExported_idx" ON "CodeSymbol"("repositoryId", "isExported");

-- CreateIndex
CREATE UNIQUE INDEX "CodeSymbol_repositoryId_fileId_name_kind_startLine_key" ON "CodeSymbol"("repositoryId", "fileId", "name", "kind", "startLine");

-- CreateIndex
CREATE INDEX "CodeDependency_repositoryId_toSymbolId_kind_idx" ON "CodeDependency"("repositoryId", "toSymbolId", "kind");

-- CreateIndex
CREATE INDEX "CodeDependency_repositoryId_fromFileId_kind_idx" ON "CodeDependency"("repositoryId", "fromFileId", "kind");

-- CreateIndex
CREATE INDEX "CodeDependency_repositoryId_toFileId_kind_idx" ON "CodeDependency"("repositoryId", "toFileId", "kind");

-- CreateIndex
CREATE INDEX "CodeDependency_repositoryId_fromSymbolId_kind_idx" ON "CodeDependency"("repositoryId", "fromSymbolId", "kind");

-- AddForeignKey
ALTER TABLE "CodeSymbol" ADD CONSTRAINT "CodeSymbol_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSymbol" ADD CONSTRAINT "CodeSymbol_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "RepositoryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeDependency" ADD CONSTRAINT "CodeDependency_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-edited (phase-04 prompt-1 §2.7/sub-task 1.3): Prisma's schema language has no
-- NULLS NOT DISTINCT syntax, so this constraint is not declared as @@unique in
-- schema.prisma — see the CodeDependency model's own comment there. Without
-- NULLS NOT DISTINCT, Postgres treats every NULL as distinct, so a plain UNIQUE
-- constraint would let the same file-level edge (which always has two NULL symbol
-- columns) be inserted an unbounded number of times. Requires Postgres 15+.
ALTER TABLE "CodeDependency"
  ADD CONSTRAINT "CodeDependency_edge_identity_key"
  UNIQUE NULLS NOT DISTINCT
  ("repositoryId", "kind", "fromFileId", "toFileId", "fromSymbolId", "toSymbolId");
