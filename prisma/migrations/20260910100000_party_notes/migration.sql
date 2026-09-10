-- CreateTable
CREATE TABLE "PartyNote" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT,
    "vendorId" TEXT,
    "body" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartyNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartyNoteFile" (
    "id" TEXT NOT NULL,
    "partyNoteId" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartyNoteFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartyNote_companyId_customerId_createdAt_idx" ON "PartyNote"("companyId", "customerId", "createdAt");

-- CreateIndex
CREATE INDEX "PartyNote_companyId_vendorId_createdAt_idx" ON "PartyNote"("companyId", "vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "PartyNoteFile_partyNoteId_idx" ON "PartyNoteFile"("partyNoteId");

-- AddForeignKey
ALTER TABLE "PartyNote" ADD CONSTRAINT "PartyNote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartyNote" ADD CONSTRAINT "PartyNote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartyNote" ADD CONSTRAINT "PartyNote_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartyNote" ADD CONSTRAINT "PartyNote_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartyNoteFile" ADD CONSTRAINT "PartyNoteFile_partyNoteId_fkey" FOREIGN KEY ("partyNoteId") REFERENCES "PartyNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A note belongs to exactly one party. Prisma cannot say this, and without it a
-- note could hang off a customer AND a vendor, appearing on two pages with two
-- different section rules deciding who may read it.
ALTER TABLE "PartyNote" ADD CONSTRAINT "PartyNote_one_party"
  CHECK (
    (CASE WHEN "customerId" IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN "vendorId"   IS NULL THEN 0 ELSE 1 END) = 1
  );

-- An empty note is a row nobody meant to create.
ALTER TABLE "PartyNote" ADD CONSTRAINT "PartyNote_body_not_blank"
  CHECK (length(btrim("body")) > 0);
