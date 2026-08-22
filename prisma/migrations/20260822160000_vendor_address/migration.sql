-- Customers carry a billing address; vendors and consultants had nowhere to put
-- one, so a remittance address had to live in the notes field or nowhere.
ALTER TABLE "Vendor" ADD COLUMN "address" TEXT;
