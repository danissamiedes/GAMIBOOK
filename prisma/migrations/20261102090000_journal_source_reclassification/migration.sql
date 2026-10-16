-- SPEC §18: entries that move a posting from one account to another.
-- Its own migration because a new enum value cannot be used in the same
-- transaction that adds it.
ALTER TYPE "JournalSourceType" ADD VALUE 'RECLASSIFICATION';
