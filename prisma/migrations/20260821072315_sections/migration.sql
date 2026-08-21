-- CreateEnum
CREATE TYPE "Section" AS ENUM ('SALES', 'CONSULTANTS', 'VENDORS', 'BANKING', 'REPORTS', 'SETTINGS');

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "sections" "Section"[] DEFAULT ARRAY[]::"Section"[];
