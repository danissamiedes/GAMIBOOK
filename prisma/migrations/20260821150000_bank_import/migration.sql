-- CreateEnum
CREATE TYPE "BankTransactionStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "BankAmountLayout" AS ENUM ('SIGNED', 'DEBIT_CREDIT');

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "dateColumn" TEXT,
    "descriptionColumn" TEXT,
    "amountColumn" TEXT,
    "debitColumn" TEXT,
    "creditColumn" TEXT,
    "referenceColumn" TEXT,
    "amountLayout" "BankAmountLayout" NOT NULL DEFAULT 'SIGNED',
    "dateFormat" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reference" TEXT,
    "importBatchId" TEXT,
    "status" "BankTransactionStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchedPaymentId" TEXT,
    "matchedBillPaymentId" TEXT,
    "matchedJournalEntryId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "matchedByUserId" TEXT,
    "createdEntry" BOOLEAN NOT NULL DEFAULT false,
    "dedupeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workOrderId" TEXT,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankAccount_companyId_isActive_idx" ON "BankAccount"("companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_companyId_name_key" ON "BankAccount"("companyId", "name");

-- CreateIndex
CREATE INDEX "BankTransaction_companyId_status_idx" ON "BankTransaction"("companyId", "status");

-- CreateIndex
CREATE INDEX "BankTransaction_bankAccountId_date_idx" ON "BankTransaction"("bankAccountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_bankAccountId_dedupeHash_key" ON "BankTransaction"("bankAccountId", "dedupeHash");

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_matchedPaymentId_fkey" FOREIGN KEY ("matchedPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_matchedBillPaymentId_fkey" FOREIGN KEY ("matchedBillPaymentId") REFERENCES "BillPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_matchedJournalEntryId_fkey" FOREIGN KEY ("matchedJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

