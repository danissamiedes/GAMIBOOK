-- Undoing a batch runs in chunks too, so "being undone" is a state (SPEC §18).
-- AlterTable
ALTER TABLE "Reclassification" ADD COLUMN     "reversalRequestedAt" TIMESTAMP(3);

