-- CreateEnum
CREATE TYPE "EmailBatchStatus" AS ENUM ('QUEUED', 'SENDING', 'COMPLETED', 'COMPLETED_WITH_FAILURES');

-- CreateEnum
CREATE TYPE "EmailBatchItemStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "EmailBatch" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'WORK_ORDER',
    "status" "EmailBatchStatus" NOT NULL DEFAULT 'QUEUED',
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "groupByConsultant" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "EmailBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailBatchItem" (
    "id" TEXT NOT NULL,
    "emailBatchId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "workOrderIds" TEXT[],
    "toAddresses" TEXT[],
    "ccAddresses" TEXT[],
    "status" "EmailBatchItemStatus" NOT NULL DEFAULT 'QUEUED',
    "reason" TEXT,
    "emailLogId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "EmailBatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailBatch_companyId_createdAt_idx" ON "EmailBatch"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailBatchItem_emailBatchId_status_idx" ON "EmailBatchItem"("emailBatchId", "status");

-- AddForeignKey
ALTER TABLE "EmailBatch" ADD CONSTRAINT "EmailBatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailBatchItem" ADD CONSTRAINT "EmailBatchItem_emailBatchId_fkey" FOREIGN KEY ("emailBatchId") REFERENCES "EmailBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

