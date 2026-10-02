-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('HELD', 'PAYMENT_SUBMITTED', 'CONFIRMED', 'CANCELLED');


-- CreateTable
CREATE TABLE "BookingSettings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "unitLabel" TEXT NOT NULL DEFAULT 'Unit',
    "unitLabelPlural" TEXT NOT NULL DEFAULT 'Units',
    "slug" TEXT NOT NULL,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "venueName" TEXT,
    "venueAddress" TEXT,
    "intro" TEXT,
    "slotMinutes" INTEGER NOT NULL DEFAULT 60,
    "opensAtMinute" INTEGER NOT NULL DEFAULT 420,
    "closesAtMinute" INTEGER NOT NULL DEFAULT 1380,
    "horizonDays" INTEGER NOT NULL DEFAULT 14,
    "paymentInstructions" TEXT,
    "holdMinutes" INTEGER NOT NULL DEFAULT 120,
    "notifyEmail" TEXT,

    CONSTRAINT "BookingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookableUnit" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookableUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingRate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "daysOfWeek" INTEGER[],
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "unitId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'HELD',
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "rateLabel" TEXT,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerPhone" TEXT,
    "note" TEXT,
    "userId" TEXT,
    "heldUntil" TIMESTAMP(3),
    "paymentProofKey" TEXT,
    "paymentProofName" TEXT,
    "paymentReference" TEXT,
    "paymentNote" TEXT,
    "paymentSubmittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "confirmedByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingSettings_companyId_key" ON "BookingSettings"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingSettings_slug_key" ON "BookingSettings"("slug");

-- CreateIndex
CREATE INDEX "BookableUnit_companyId_sortOrder_idx" ON "BookableUnit"("companyId", "sortOrder");

-- CreateIndex
CREATE INDEX "BookingRate_companyId_startMinute_idx" ON "BookingRate"("companyId", "startMinute");

-- CreateIndex
CREATE INDEX "Booking_companyId_date_idx" ON "Booking"("companyId", "date");

-- CreateIndex
CREATE INDEX "Booking_companyId_status_idx" ON "Booking"("companyId", "status");

-- CreateIndex
CREATE INDEX "Booking_unitId_date_startMinute_idx" ON "Booking"("unitId", "date", "startMinute");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_companyId_reference_key" ON "Booking"("companyId", "reference");

-- AddForeignKey
ALTER TABLE "BookingSettings" ADD CONSTRAINT "BookingSettings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookableUnit" ADD CONSTRAINT "BookableUnit_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRate" ADD CONSTRAINT "BookingRate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRate" ADD CONSTRAINT "BookingRate_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "BookableUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "BookableUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Two people can press Book on the same slot in the same second, and the
-- loser must find out from the database rather than from the other player
-- turning up. Prisma cannot express a partial unique index, so it is written
-- here: a cancelled booking releases the slot, everything else holds it.
CREATE UNIQUE INDEX "Booking_slot_taken"
    ON "Booking" ("unitId", "date", "startMinute")
    WHERE "status" <> 'CANCELLED';
