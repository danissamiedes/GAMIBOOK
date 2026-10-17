-- A reclassification is planned first and posted in chunks (SPEC §18).
--
-- A batch of several hundred postings cannot be written in one interactive
-- transaction — the ceiling is 20s and a posting is a couple of dozen round
-- trips — so the lines are reserved up front with no entry yet, and each one
-- gains its entry as the chunks run.
-- DropForeignKey
ALTER TABLE "ReclassificationLine" DROP CONSTRAINT "ReclassificationLine_journalEntryId_fkey";

-- AlterTable
ALTER TABLE "Reclassification" ADD COLUMN     "completedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ReclassificationLine" ALTER COLUMN "journalEntryId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "ReclassificationLine" ADD CONSTRAINT "ReclassificationLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

