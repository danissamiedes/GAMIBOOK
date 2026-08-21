-- CreateEnum
CREATE TYPE "ImportBatchKind" AS ENUM ('WORK_ORDER', 'BANK', 'MIGRATION');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PARSED', 'COMMITTED', 'DISCARDED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('VALID', 'WARNING', 'ERROR', 'IMPORTED', 'SKIPPED');

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "ImportBatchKind" NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PARSED',
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "fileKey" TEXT,
    "sheetName" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "uploadedByUserId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "rawJson" JSONB NOT NULL,
    "parsedJson" JSONB,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'VALID',
    "issues" JSONB,
    "workOrderId" TEXT,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_companyId_kind_uploadedAt_idx" ON "ImportBatch"("companyId", "kind", "uploadedAt");

-- CreateIndex
CREATE INDEX "ImportBatch_companyId_fileHash_idx" ON "ImportBatch"("companyId", "fileHash");

-- CreateIndex
CREATE INDEX "ImportRow_importBatchId_status_idx" ON "ImportRow"("importBatchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_importBatchId_rowNumber_key" ON "ImportRow"("importBatchId", "rowNumber");

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

