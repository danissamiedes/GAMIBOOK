-- CreateIndex
CREATE INDEX "Expense_companyId_kind_date_idx" ON "Expense"("companyId", "kind", "date");

-- CreateIndex
CREATE INDEX "Invoice_companyId_issueDate_idx" ON "Invoice"("companyId", "issueDate");

-- CreateIndex
CREATE INDEX "WorkOrder_companyId_approvedAt_idx" ON "WorkOrder"("companyId", "approvedAt");

