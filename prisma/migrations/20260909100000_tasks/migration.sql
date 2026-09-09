-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'COMPLETED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "note" TEXT,
    "dueDate" DATE,
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "assignedUserId" TEXT,
    "createdByUserId" TEXT,
    "invoiceId" TEXT,
    "salesOrderId" TEXT,
    "workOrderId" TEXT,
    "expenseId" TEXT,
    "billPaymentId" TEXT,
    "paymentId" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_companyId_status_dueDate_idx" ON "Task"("companyId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "Task_companyId_assignedUserId_status_idx" ON "Task"("companyId", "assignedUserId", "status");

-- CreateIndex
CREATE INDEX "Task_invoiceId_idx" ON "Task"("invoiceId");

-- CreateIndex
CREATE INDEX "Task_salesOrderId_idx" ON "Task"("salesOrderId");

-- CreateIndex
CREATE INDEX "Task_workOrderId_idx" ON "Task"("workOrderId");

-- CreateIndex
CREATE INDEX "Task_expenseId_idx" ON "Task"("expenseId");

-- CreateIndex
CREATE INDEX "Task_billPaymentId_idx" ON "Task"("billPaymentId");

-- CreateIndex
CREATE INDEX "Task_paymentId_idx" ON "Task"("paymentId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_billPaymentId_fkey" FOREIGN KEY ("billPaymentId") REFERENCES "BillPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A task hangs on one document or none. Prisma cannot express this, and
-- without it a task could claim to be about an invoice AND a work order, which
-- would make it visible under two sections and listed twice.
ALTER TABLE "Task" ADD CONSTRAINT "Task_one_document"
  CHECK (
    (CASE WHEN "invoiceId"     IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN "salesOrderId"  IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN "workOrderId"   IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN "expenseId"     IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN "billPaymentId" IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN "paymentId"     IS NULL THEN 0 ELSE 1 END) <= 1
  );

-- A completed task knows when. Anything else is a status nobody can trust.
ALTER TABLE "Task" ADD CONSTRAINT "Task_completed_has_a_time"
  CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL));
