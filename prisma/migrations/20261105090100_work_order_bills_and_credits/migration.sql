-- SPEC §8.1b and §8.5.
--
-- Two changes that belong together, because both are about when a payable
-- comes into existence.
--
--   * A work order stops being a payable on approval and becomes one when it
--     is turned into a bill. Everything approved before this deploy already
--     posted, so it is marked postedOnApproval and keeps the old behaviour —
--     nothing in anybody's books moves.
--   * Credit notes from suppliers and consultants, and what they have been
--     set against. A bill carries creditedAmount separately from amountPaid,
--     because a credit is not money.
-- CreateEnum
CREATE TYPE "VendorCreditStatus" AS ENUM ('OPEN', 'PARTIALLY_APPLIED', 'APPLIED', 'VOID');

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "creditedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "workOrderId" TEXT;

-- AlterTable
ALTER TABLE "WorkOrder" ADD COLUMN     "billedAt" TIMESTAMP(3),
ADD COLUMN     "postedOnApproval" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "VendorCredit" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "reference" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "fxRate" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "amount" DECIMAL(18,2) NOT NULL,
    "baseTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amountApplied" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "expenseAccountId" TEXT NOT NULL,
    "memo" TEXT,
    "status" "VendorCreditStatus" NOT NULL DEFAULT 'OPEN',
    "voidedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorCreditApplication" (
    "id" TEXT NOT NULL,
    "vendorCreditId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "amountApplied" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorCreditApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorCredit_companyId_vendorId_idx" ON "VendorCredit"("companyId", "vendorId");

-- CreateIndex
CREATE INDEX "VendorCredit_companyId_status_idx" ON "VendorCredit"("companyId", "status");

-- CreateIndex
CREATE INDEX "VendorCreditApplication_vendorCreditId_idx" ON "VendorCreditApplication"("vendorCreditId");

-- CreateIndex
CREATE INDEX "VendorCreditApplication_expenseId_idx" ON "VendorCreditApplication"("expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_workOrderId_key" ON "Expense"("workOrderId");

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorCredit" ADD CONSTRAINT "VendorCredit_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorCredit" ADD CONSTRAINT "VendorCredit_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorCreditApplication" ADD CONSTRAINT "VendorCreditApplication_vendorCreditId_fkey" FOREIGN KEY ("vendorCreditId") REFERENCES "VendorCredit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorCreditApplication" ADD CONSTRAINT "VendorCreditApplication_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Everything that posted on approval keeps saying so. "Has a journal entry"
-- is the honest test: it is exactly the set whose cost is already in A/P.
UPDATE "WorkOrder" w
   SET "postedOnApproval" = true
 WHERE EXISTS (
   SELECT 1 FROM "JournalEntry" e
    WHERE e."sourceType" = 'WORK_ORDER' AND e."sourceId" = w."id"
 );
