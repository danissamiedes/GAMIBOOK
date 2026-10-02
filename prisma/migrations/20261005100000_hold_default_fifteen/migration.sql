-- A hold is fifteen minutes by default, not two hours.
--
-- Only the default moves: every venue that has already chosen a hold length
-- keeps it, because a stored value is a decision somebody made.
ALTER TABLE "BookingSettings" ALTER COLUMN "holdMinutes" SET DEFAULT 15;
