-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "AccountSubtype" AS ENUM ('CASH', 'UNDEPOSITED_FUNDS', 'ACCOUNTS_RECEIVABLE', 'OTHER_CURRENT_ASSET', 'FIXED_ASSET', 'ACCOUNTS_PAYABLE', 'CREDIT_CARD', 'OTHER_CURRENT_LIABILITY', 'LONG_TERM_LIABILITY', 'EQUITY', 'RETAINED_EARNINGS', 'INCOME', 'OTHER_INCOME', 'COST_OF_SALES', 'EXPENSE', 'OTHER_EXPENSE');

-- CreateEnum
CREATE TYPE "JournalSourceType" AS ENUM ('MANUAL', 'INVOICE', 'INVOICE_PAYMENT', 'WORK_ORDER', 'CONSULTANT_PAYMENT', 'EXPENSE', 'BANK_TRANSACTION', 'OPENING_BALANCE', 'MIGRATION');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "subtype" "AccountSubtype" NOT NULL,
    "parentId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "systemKey" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entryNumber" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "memo" TEXT,
    "sourceType" "JournalSourceType" NOT NULL,
    "sourceId" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "reversedByEntryId" TEXT,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "description" TEXT,
    "customerId" TEXT,
    "consultantId" TEXT,
    "vendorId" TEXT,
    "currency" CHAR(3),
    "fxRate" DECIMAL(18,8),
    "foreignAmount" DECIMAL(18,2),

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Account_companyId_type_idx" ON "Account"("companyId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Account_companyId_code_key" ON "Account"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Account_companyId_systemKey_key" ON "Account"("companyId", "systemKey");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversedByEntryId_key" ON "JournalEntry"("reversedByEntryId");

-- CreateIndex
CREATE INDEX "JournalEntry_companyId_date_idx" ON "JournalEntry"("companyId", "date");

-- CreateIndex
CREATE INDEX "JournalEntry_companyId_sourceType_sourceId_idx" ON "JournalEntry"("companyId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_companyId_entryNumber_key" ON "JournalEntry"("companyId", "entryNumber");

-- CreateIndex
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");

-- CreateIndex
CREATE INDEX "JournalLine_customerId_idx" ON "JournalLine"("customerId");

-- CreateIndex
CREATE INDEX "JournalLine_consultantId_idx" ON "JournalLine"("consultantId");

-- CreateIndex
CREATE INDEX "JournalLine_vendorId_idx" ON "JournalLine"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalLine_journalEntryId_lineNumber_key" ON "JournalLine"("journalEntryId", "lineNumber");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversedByEntryId_fkey" FOREIGN KEY ("reversedByEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- SPEC §4.2 hard rules, enforced in the database as well as in code.
--
-- The service layer (src/lib/ledger/post.ts) checks all of this before it
-- writes. These exist because "one service function does the posting" is a
-- rule about our code, and the books deserve a guarantee that survives a bug,
-- a migration script, or someone at a psql prompt.
-- ---------------------------------------------------------------------------

-- Rule: exactly one of debit/credit is non-zero, and neither is negative.
ALTER TABLE "JournalLine"
  ADD CONSTRAINT "journal_line_amounts_non_negative"
  CHECK ("debit" >= 0 AND "credit" >= 0);

ALTER TABLE "JournalLine"
  ADD CONSTRAINT "journal_line_exactly_one_side"
  CHECK (("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0));

-- Rule: every entry has at least 2 lines and debits equal credits to the cent.
-- Deferred to commit time, because the lines are inserted after the header.
CREATE OR REPLACE FUNCTION assert_journal_entry_balanced() RETURNS TRIGGER AS $$
DECLARE
  line_count INTEGER;
  debit_total NUMERIC(18,2);
  credit_total NUMERIC(18,2);
BEGIN
  SELECT COUNT(*), COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0)
    INTO line_count, debit_total, credit_total
    FROM "JournalLine" WHERE "journalEntryId" = NEW."id";

  -- The entry row may survive a rolled-back line insert in the same statement;
  -- an entry with no lines at all is handled by the >= 2 check below.
  IF line_count < 2 THEN
    RAISE EXCEPTION 'Journal entry % has % line(s); at least 2 are required', NEW."id", line_count;
  END IF;

  IF debit_total <> credit_total THEN
    RAISE EXCEPTION 'Journal entry % is out of balance: debits %, credits %',
      NEW."id", debit_total, credit_total;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "journal_entry_must_balance"
  AFTER INSERT OR UPDATE ON "JournalEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_entry_balanced();

-- The same check has to fire when lines change, or an entry could be knocked
-- out of balance after its header was written.
CREATE OR REPLACE FUNCTION assert_line_entry_balanced() RETURNS TRIGGER AS $$
DECLARE
  entry_id TEXT;
  line_count INTEGER;
  debit_total NUMERIC(18,2);
  credit_total NUMERIC(18,2);
BEGIN
  entry_id := COALESCE(NEW."journalEntryId", OLD."journalEntryId");

  -- Nothing to check if the whole entry went away (cascade delete).
  IF NOT EXISTS (SELECT 1 FROM "JournalEntry" WHERE "id" = entry_id) THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*), COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0)
    INTO line_count, debit_total, credit_total
    FROM "JournalLine" WHERE "journalEntryId" = entry_id;

  IF line_count < 2 THEN
    RAISE EXCEPTION 'Journal entry % has % line(s); at least 2 are required', entry_id, line_count;
  END IF;

  IF debit_total <> credit_total THEN
    RAISE EXCEPTION 'Journal entry % is out of balance: debits %, credits %',
      entry_id, debit_total, credit_total;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "journal_line_must_balance"
  AFTER INSERT OR UPDATE OR DELETE ON "JournalLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_line_entry_balanced();

-- Rule: posted entries are immutable. To change one, post a reversal.
-- The single exception is linking an entry to the reversal that undid it.
CREATE OR REPLACE FUNCTION assert_journal_entry_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Journal entries are immutable: entry % cannot be deleted, post a reversal instead', OLD."id";
  END IF;

  IF NEW."companyId" IS DISTINCT FROM OLD."companyId"
     OR NEW."entryNumber" IS DISTINCT FROM OLD."entryNumber"
     OR NEW."date" IS DISTINCT FROM OLD."date"
     OR NEW."memo" IS DISTINCT FROM OLD."memo"
     OR NEW."sourceType" IS DISTINCT FROM OLD."sourceType"
     OR NEW."sourceId" IS DISTINCT FROM OLD."sourceId"
     OR NEW."postedAt" IS DISTINCT FROM OLD."postedAt"
     OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId" THEN
    RAISE EXCEPTION 'Journal entries are immutable: entry % cannot be edited, post a reversal instead', OLD."id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "journal_entry_immutable"
  BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION assert_journal_entry_immutable();

CREATE OR REPLACE FUNCTION assert_journal_line_immutable() RETURNS TRIGGER AS $$
BEGIN
  -- A line may only disappear with its entry (cascade), never on its own.
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "JournalEntry" WHERE "id" = OLD."journalEntryId") THEN
      RAISE EXCEPTION 'Journal lines are immutable: line % cannot be deleted, post a reversal instead', OLD."id";
    END IF;
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Journal lines are immutable: line % cannot be edited, post a reversal instead', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "journal_line_immutable"
  BEFORE UPDATE OR DELETE ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION assert_journal_line_immutable();
