/*
  Warnings:

  - You are about to drop the column `consultantId` on the `JournalLine` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "VendorKind" AS ENUM ('CONSULTANT', 'REGULAR');

-- CreateEnum
CREATE TYPE "PayableStatus" AS ENUM ('DRAFT', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "ExpenseKind" AS ENUM ('DIRECT', 'BILL');

-- DropIndex
DROP INDEX "JournalLine_consultantId_idx";

-- AlterTable
ALTER TABLE "JournalLine" DROP COLUMN "consultantId";

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "VendorKind" NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "defaultCurrency" CHAR(3) NOT NULL,
    "defaultAccountId" TEXT,
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "defaultRate" DECIMAL(18,6),
    "userId" TEXT,
    "ccEmails" TEXT[],
    "sendEmails" BOOLEAN NOT NULL DEFAULT true,
    "externalRef" TEXT,
    "importAliases" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrder" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "workOrderNumber" TEXT,
    "issueDate" DATE NOT NULL,
    "approvedAt" DATE,
    "dueDate" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "fxRate" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "status" "PayableStatus" NOT NULL DEFAULT 'DRAFT',
    "memo" TEXT,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "balanceDue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "baseTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "baseRelieved" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lastEmailedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderLine" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "rate" DECIMAL(18,6) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "accountId" TEXT NOT NULL,

    CONSTRAINT "WorkOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vendorId" TEXT,
    "date" DATE NOT NULL,
    "kind" "ExpenseKind" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "fxRate" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "paymentAccountId" TEXT,
    "expenseAccountId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "receiptFileKey" TEXT,
    "isBillable" BOOLEAN NOT NULL DEFAULT false,
    "customerId" TEXT,
    "dueDate" DATE,
    "status" "PayableStatus" NOT NULL DEFAULT 'PAID',
    "amountPaid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "balanceDue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "baseTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "baseRelieved" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillPayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "fxRate" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "paymentAccountId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "reference" TEXT,
    "notes" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillPaymentApplication" (
    "id" TEXT NOT NULL,
    "billPaymentId" TEXT NOT NULL,
    "workOrderId" TEXT,
    "expenseId" TEXT,
    "amountApplied" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "BillPaymentApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Vendor_companyId_kind_name_idx" ON "Vendor"("companyId", "kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_companyId_externalRef_key" ON "Vendor"("companyId", "externalRef");

-- CreateIndex
CREATE INDEX "WorkOrder_companyId_status_idx" ON "WorkOrder"("companyId", "status");

-- CreateIndex
CREATE INDEX "WorkOrder_companyId_vendorId_idx" ON "WorkOrder"("companyId", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_companyId_workOrderNumber_key" ON "WorkOrder"("companyId", "workOrderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrderLine_workOrderId_lineNumber_key" ON "WorkOrderLine"("workOrderId", "lineNumber");

-- CreateIndex
CREATE INDEX "Expense_companyId_kind_status_idx" ON "Expense"("companyId", "kind", "status");

-- CreateIndex
CREATE INDEX "Expense_companyId_vendorId_idx" ON "Expense"("companyId", "vendorId");

-- CreateIndex
CREATE INDEX "BillPayment_companyId_date_idx" ON "BillPayment"("companyId", "date");

-- CreateIndex
CREATE INDEX "BillPayment_companyId_vendorId_idx" ON "BillPayment"("companyId", "vendorId");

-- CreateIndex
CREATE INDEX "BillPaymentApplication_workOrderId_idx" ON "BillPaymentApplication"("workOrderId");

-- CreateIndex
CREATE INDEX "BillPaymentApplication_expenseId_idx" ON "BillPaymentApplication"("expenseId");

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderLine" ADD CONSTRAINT "WorkOrderLine_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillPaymentApplication" ADD CONSTRAINT "BillPaymentApplication_billPaymentId_fkey" FOREIGN KEY ("billPaymentId") REFERENCES "BillPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillPaymentApplication" ADD CONSTRAINT "BillPaymentApplication_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillPaymentApplication" ADD CONSTRAINT "BillPaymentApplication_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
