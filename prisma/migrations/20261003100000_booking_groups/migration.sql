-- Multi-slot bookings (SPEC §17).
--
-- A booking used to BE a slot. It is now a group of slots paid for together:
-- two hours on one court, or one hour across three, is one payment. The slot
-- row survives because it is what the unique index guards — the claim on one
-- court for one hour — but everything about the booker and the money moves up
-- to the group.
--
-- Written by hand rather than generated, because the generated version drops
-- the moved columns and takes every existing booking with them.

-- CreateTable
CREATE TABLE "BookingGroup" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'HELD',
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
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

    CONSTRAINT "BookingGroup_pkey" PRIMARY KEY ("id")
);

-- Every booking that already exists becomes a group of one. Same reference,
-- same money, same status: a booker holding a slip of paper with ABC-123 on it
-- must still find their booking after this runs.
INSERT INTO "BookingGroup" (
    "id", "companyId", "reference", "date", "status", "amount", "currency",
    "customerName", "customerEmail", "customerPhone", "note", "userId",
    "heldUntil", "paymentProofKey", "paymentProofName", "paymentReference",
    "paymentNote", "paymentSubmittedAt", "confirmedAt", "confirmedByUserId",
    "cancelledAt", "cancelReason", "createdAt", "updatedAt"
)
SELECT
    "id", "companyId", "reference", "date", "status", "amount", "currency",
    "customerName", "customerEmail", "customerPhone", "note", "userId",
    "heldUntil", "paymentProofKey", "paymentProofName", "paymentReference",
    "paymentNote", "paymentSubmittedAt", "confirmedAt", "confirmedByUserId",
    "cancelledAt", "cancelReason", "createdAt", "updatedAt"
FROM "Booking";

-- The slot points at its group. The id is reused above, so the backfill is a
-- straight copy rather than a join on anything that could be ambiguous.
ALTER TABLE "Booking" ADD COLUMN "groupId" TEXT;
UPDATE "Booking" SET "groupId" = "id";
ALTER TABLE "Booking" ALTER COLUMN "groupId" SET NOT NULL;

-- Now the moved columns can go.
DROP INDEX IF EXISTS "Booking_companyId_reference_key";
DROP INDEX IF EXISTS "Booking_companyId_status_idx";
ALTER TABLE "Booking"
    DROP COLUMN "reference",
    DROP COLUMN "currency",
    DROP COLUMN "customerName",
    DROP COLUMN "customerEmail",
    DROP COLUMN "customerPhone",
    DROP COLUMN "note",
    DROP COLUMN "userId",
    DROP COLUMN "heldUntil",
    DROP COLUMN "paymentProofKey",
    DROP COLUMN "paymentProofName",
    DROP COLUMN "paymentReference",
    DROP COLUMN "paymentNote",
    DROP COLUMN "paymentSubmittedAt",
    DROP COLUMN "confirmedAt",
    DROP COLUMN "confirmedByUserId",
    DROP COLUMN "cancelledAt",
    DROP COLUMN "cancelReason";

-- CreateIndex
CREATE UNIQUE INDEX "BookingGroup_companyId_reference_key" ON "BookingGroup"("companyId", "reference");
CREATE INDEX "BookingGroup_companyId_date_idx" ON "BookingGroup"("companyId", "date");
CREATE INDEX "BookingGroup_companyId_status_idx" ON "BookingGroup"("companyId", "status");
CREATE INDEX "Booking_groupId_idx" ON "Booking"("groupId");

-- AddForeignKey
ALTER TABLE "BookingGroup" ADD CONSTRAINT "BookingGroup_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BookingGroup" ADD CONSTRAINT "BookingGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "BookingGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
