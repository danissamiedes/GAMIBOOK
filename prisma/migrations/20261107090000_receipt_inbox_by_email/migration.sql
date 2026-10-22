-- Bills that arrive by email (SPEC §8.2 extension).
--
-- A book publishes a forwarding address; the hourly poll of the connected
-- mailbox files what arrives there, parks the attachments in Drive and
-- lists the message until somebody records it. Nothing here is in the
-- books, so there is nothing to backfill: an empty inbox is correct.

-- CreateEnum
CREATE TYPE "InboxStatus" AS ENUM ('WAITING', 'RECORDED', 'DISMISSED');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "inboxAddress" TEXT,
ADD COLUMN     "inboxDriveFolderId" TEXT;

-- CreateTable
CREATE TABLE "InboxMessage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "deliveredTo" TEXT,
    "snippet" TEXT,
    "status" "InboxStatus" NOT NULL DEFAULT 'WAITING',
    "expenseId" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "dismissedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "driveFileId" TEXT,
    "viewUrl" TEXT,
    "uploadError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboxMessage_expenseId_key" ON "InboxMessage"("expenseId");

-- CreateIndex
CREATE INDEX "InboxMessage_companyId_status_receivedAt_idx" ON "InboxMessage"("companyId", "status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboxMessage_companyId_providerId_key" ON "InboxMessage"("companyId", "providerId");

-- CreateIndex
CREATE INDEX "InboxAttachment_messageId_idx" ON "InboxAttachment"("messageId");

-- AddForeignKey
ALTER TABLE "InboxMessage" ADD CONSTRAINT "InboxMessage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxMessage" ADD CONSTRAINT "InboxMessage_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxAttachment" ADD CONSTRAINT "InboxAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "InboxMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

