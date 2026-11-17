-- A bulk payment run is posted in chunks, because one request cannot hold
-- sixty consultants' worth of postings on a serverless host (SPEC §6).
-- Stamping each payment with its run is what makes a resumed chunk safe: a
-- consultant already paid under this run is skipped rather than paid again.
-- AlterTable
ALTER TABLE "BillPayment" ADD COLUMN     "bulkRunId" TEXT;

-- CreateIndex
CREATE INDEX "BillPayment_companyId_bulkRunId_idx" ON "BillPayment"("companyId", "bulkRunId");

