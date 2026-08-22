
-- CreateEnum
CREATE TYPE "ReceiptSource" AS ENUM ('UPLOAD', 'GOOGLE_DRIVE');

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "receiptUrl" TEXT;

-- AlterTable
ALTER TABLE "ReceiptUpload" ADD COLUMN     "source" "ReceiptSource" NOT NULL DEFAULT 'UPLOAD',
ADD COLUMN     "sourceFileId" TEXT,
ADD COLUMN     "sourceUrl" TEXT,
ALTER COLUMN "fileKey" DROP NOT NULL;

-- CreateTable
CREATE TABLE "DriveWatch" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "folderName" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "queuedTotal" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveWatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriveWatch_companyId_key" ON "DriveWatch"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptUpload_companyId_sourceFileId_key" ON "ReceiptUpload"("companyId", "sourceFileId");

-- AddForeignKey
ALTER TABLE "DriveWatch" ADD CONSTRAINT "DriveWatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

