-- Google Drive folder watching was built and then not wanted. Removing it
-- rather than leaving it switched off: a table nothing writes to and a
-- nullable column that can never be null are how a schema stops describing
-- the system.

-- Any queued receipt that only ever lived in Drive has no image behind it now,
-- and none was ever approved into an expense (the feature was never
-- configured). Drop those rows before the column goes back to NOT NULL.
DELETE FROM "ReceiptUpload" WHERE "fileKey" IS NULL;

DROP TABLE IF EXISTS "DriveWatch";

-- "Expense"."receiptUrl" stays: the automatic sync is gone, but the field it
-- wrote to is now filled in by hand from the receipt entry form.

DROP INDEX IF EXISTS "ReceiptUpload_companyId_sourceFileId_key";

ALTER TABLE "ReceiptUpload"
  DROP COLUMN IF EXISTS "source",
  DROP COLUMN IF EXISTS "sourceFileId",
  DROP COLUMN IF EXISTS "sourceUrl",
  ALTER COLUMN "fileKey" SET NOT NULL;

DROP TYPE IF EXISTS "ReceiptSource";
