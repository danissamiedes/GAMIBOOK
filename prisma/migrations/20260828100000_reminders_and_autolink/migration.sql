-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "bankAutoLinkEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "invoiceRemindersEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "sendEmails" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "lastRemindedAt" TIMESTAMP(3);

