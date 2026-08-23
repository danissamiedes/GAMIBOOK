-- Recurring bills and direct expenses (SPEC §8.2a) — the payables mirror of
-- recurring invoices. Same schedule fields, so the same date maths serves both.
--
-- RecurringBillRun's (templateId, scheduledDate) unique index is the whole
-- concurrency story: the generator claims that row before doing anything, so
-- two overlapping schedulers cannot record the same month's rent twice. The
-- deployment runs one on Vercel and one on GitHub Actions on purpose, so this
-- is not a theoretical case.

-- CreateTable
CREATE TABLE "RecurringBillTemplate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vendorId" TEXT,
    "name" TEXT NOT NULL,
    "kind" "ExpenseKind" NOT NULL,
    "frequency" "RecurringFrequency" NOT NULL,
    "dayOfMonth" INTEGER,
    "dayOfWeek" INTEGER,
    "monthOfYear" INTEGER,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "occurrenceLimit" INTEGER,
    "nextRunDate" DATE NOT NULL,
    "lastRunDate" DATE,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 0,
    "isPaused" BOOLEAN NOT NULL DEFAULT false,
    "currency" CHAR(3) NOT NULL,
    "fxRate" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "amount" DECIMAL(18,2) NOT NULL,
    "expenseAccountId" TEXT NOT NULL,
    "paymentAccountId" TEXT,
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringBillTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringBillRun" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "scheduledDate" DATE NOT NULL,
    "expenseId" TEXT,
    "skippedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringBillRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringBillTemplate_companyId_nextRunDate_idx" ON "RecurringBillTemplate"("companyId", "nextRunDate");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringBillRun_expenseId_key" ON "RecurringBillRun"("expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringBillRun_templateId_scheduledDate_key" ON "RecurringBillRun"("templateId", "scheduledDate");

-- AddForeignKey
ALTER TABLE "RecurringBillTemplate" ADD CONSTRAINT "RecurringBillTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringBillTemplate" ADD CONSTRAINT "RecurringBillTemplate_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringBillTemplate" ADD CONSTRAINT "RecurringBillTemplate_expenseAccountId_fkey" FOREIGN KEY ("expenseAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringBillTemplate" ADD CONSTRAINT "RecurringBillTemplate_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringBillRun" ADD CONSTRAINT "RecurringBillRun_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "RecurringBillTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringBillRun" ADD CONSTRAINT "RecurringBillRun_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

