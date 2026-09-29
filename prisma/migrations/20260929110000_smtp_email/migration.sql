-- CreateEnum
CREATE TYPE "EmailProvider" AS ENUM ('GOOGLE', 'SMTP');

-- AlterTable
ALTER TABLE "EmailConnection" ADD COLUMN     "provider" "EmailProvider" NOT NULL DEFAULT 'GOOGLE',
ADD COLUMN     "smtpHost" TEXT,
ADD COLUMN     "smtpPasswordCiphertext" TEXT,
ADD COLUMN     "smtpPasswordKey" TEXT,
ADD COLUMN     "smtpPort" INTEGER,
ADD COLUMN     "smtpSecure" BOOLEAN DEFAULT true,
ADD COLUMN     "smtpUsername" TEXT,
ALTER COLUMN "refreshTokenCiphertext" DROP NOT NULL,
ALTER COLUMN "encryptedDataKey" DROP NOT NULL,
ALTER COLUMN "scope" SET DEFAULT '';

