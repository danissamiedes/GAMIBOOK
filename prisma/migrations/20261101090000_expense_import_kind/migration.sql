-- A batch of expenses imported from a spreadsheet (SPEC §8.3).
--
-- On its own, because Postgres refuses to use a new enum value inside the
-- transaction that adds it, and the table work below would do exactly that.
ALTER TYPE "ImportBatchKind" ADD VALUE 'EXPENSE';
