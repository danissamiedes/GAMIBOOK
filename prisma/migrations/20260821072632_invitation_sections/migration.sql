-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "sections" "Section"[] DEFAULT ARRAY[]::"Section"[];
