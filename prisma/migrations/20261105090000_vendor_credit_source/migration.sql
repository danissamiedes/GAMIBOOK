-- SPEC §8.5: credit notes from suppliers and consultants.
--
-- Its own migration: a new enum value cannot be used in the transaction that
-- adds it, and the tables below post with it.
ALTER TYPE "JournalSourceType" ADD VALUE 'VENDOR_CREDIT';
