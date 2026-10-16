-- SPEC §18. Moving postings from one account to another, in bulk.
--
-- Nothing here touches what was posted: a reclassification is a record of a
-- decision, and each line it carries points at the original posting, the
-- entry that moved it, and the entry that moved it back.
--
-- The two SET DEFAULT lines bring the DB in line with the schema's
-- `@default([])` on the alias columns, which earlier hand-written migrations
-- left out.
-- AlterTable
ALTER TABLE "Vendor" ALTER COLUMN "importAliases" SET DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "Reclassification" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fromAccountId" TEXT NOT NULL,
    "toAccountId" TEXT NOT NULL,
    "reason" TEXT,
    "postedOnDate" DATE,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedByUserId" TEXT,

    CONSTRAINT "Reclassification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReclassificationLine" (
    "id" TEXT NOT NULL,
    "reclassificationId" TEXT NOT NULL,
    "sourceJournalLineId" TEXT NOT NULL,
    "activeSourceLineId" TEXT,
    "journalEntryId" TEXT NOT NULL,
    "reversalEntryId" TEXT,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "ReclassificationLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reclassification_companyId_createdAt_idx" ON "Reclassification"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReclassificationLine_activeSourceLineId_key" ON "ReclassificationLine"("activeSourceLineId");

-- CreateIndex
CREATE INDEX "ReclassificationLine_reclassificationId_idx" ON "ReclassificationLine"("reclassificationId");

-- CreateIndex
CREATE INDEX "ReclassificationLine_sourceJournalLineId_idx" ON "ReclassificationLine"("sourceJournalLineId");

-- AddForeignKey
ALTER TABLE "Reclassification" ADD CONSTRAINT "Reclassification_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reclassification" ADD CONSTRAINT "Reclassification_fromAccountId_fkey" FOREIGN KEY ("fromAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reclassification" ADD CONSTRAINT "Reclassification_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reclassification" ADD CONSTRAINT "Reclassification_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reclassification" ADD CONSTRAINT "Reclassification_reversedByUserId_fkey" FOREIGN KEY ("reversedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReclassificationLine" ADD CONSTRAINT "ReclassificationLine_reclassificationId_fkey" FOREIGN KEY ("reclassificationId") REFERENCES "Reclassification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReclassificationLine" ADD CONSTRAINT "ReclassificationLine_sourceJournalLineId_fkey" FOREIGN KEY ("sourceJournalLineId") REFERENCES "JournalLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReclassificationLine" ADD CONSTRAINT "ReclassificationLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReclassificationLine" ADD CONSTRAINT "ReclassificationLine_reversalEntryId_fkey" FOREIGN KEY ("reversalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

