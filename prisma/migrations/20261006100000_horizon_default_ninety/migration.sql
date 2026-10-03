-- A venue offers ninety days by default rather than fourteen.
--
-- Only the default moves. A venue that has already chosen how far ahead it
-- takes bookings keeps that choice, the same as the hold length.
ALTER TABLE "BookingSettings" ALTER COLUMN "horizonDays" SET DEFAULT 90;
