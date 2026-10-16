-- How a client's own category names reach this company's accounts.
--
-- "Materials" in a project spreadsheet is some particular account here. The
-- mapping is chosen once in an import preview and remembered, the same way a
-- consultant's name spellings already are.
ALTER TABLE "Account" ADD COLUMN "importAliases" TEXT[] DEFAULT ARRAY[]::TEXT[];
