
-- CreateEnum
CREATE TYPE "CompanyTheme" AS ENUM ('BLUE', 'GREEN', 'PINK', 'VIOLET', 'TEAL', 'AMBER');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "theme" "CompanyTheme" NOT NULL DEFAULT 'BLUE';


-- One-time: give the companies that already existed distinct accents, so the
-- feature is on the moment it deploys rather than after someone visits three
-- settings screens. Anything not named here keeps the default blue, and every
-- company's accent is editable under Settings → Company afterwards.
UPDATE "Company" SET "theme" = 'GREEN' WHERE upper("name") LIKE 'KASAGAMI%';
UPDATE "Company" SET "theme" = 'PINK'  WHERE upper("name") LIKE 'POISE%';
