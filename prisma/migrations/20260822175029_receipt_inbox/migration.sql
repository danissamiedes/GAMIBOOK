-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('PENDING', 'READY', 'APPROVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "ReceiptUpload" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'PENDING',
    "readDate" DATE,
    "readAmount" DECIMAL(18,2),
    "readCurrency" CHAR(3),
    "readDescription" TEXT,
    "readVendorName" TEXT,
    "readConfidence" DECIMAL(3,2),
    "readError" TEXT,
    "readAt" TIMESTAMP(3),
    "expenseId" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "dismissedReason" TEXT,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptUpload_expenseId_key" ON "ReceiptUpload"("expenseId");

-- CreateIndex
CREATE INDEX "ReceiptUpload_companyId_status_createdAt_idx" ON "ReceiptUpload"("companyId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "ReceiptUpload" ADD CONSTRAINT "ReceiptUpload_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptUpload" ADD CONSTRAINT "ReceiptUpload_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptUpload" ADD CONSTRAINT "ReceiptUpload_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
