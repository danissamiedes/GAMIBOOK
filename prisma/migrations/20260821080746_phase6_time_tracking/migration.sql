-- CreateEnum
CREATE TYPE "TimeEntrySource" AS ENUM ('SELF', 'ADMIN_ENTERED', 'ADMIN_EDITED', 'AUTO_CLOSED');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "maxShiftHours" INTEGER NOT NULL DEFAULT 16;

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "consultantId" TEXT NOT NULL,
    "clockInAt" TIMESTAMP(3) NOT NULL,
    "clockOutAt" TIMESTAMP(3),
    "durationMinutes" INTEGER,
    "note" TEXT,
    "source" "TimeEntrySource" NOT NULL DEFAULT 'SELF',
    "editedByUserId" TEXT,
    "editReason" TEXT,
    "originalClockInAt" TIMESTAMP(3),
    "originalClockOutAt" TIMESTAMP(3),
    "correctionRequest" TEXT,
    "correctionResolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimeEntry_companyId_consultantId_clockInAt_idx" ON "TimeEntry"("companyId", "consultantId", "clockInAt");

-- CreateIndex
CREATE INDEX "TimeEntry_companyId_clockOutAt_idx" ON "TimeEntry"("companyId", "clockOutAt");

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
