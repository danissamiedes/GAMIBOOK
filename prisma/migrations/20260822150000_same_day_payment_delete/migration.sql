-- Posted entries stay immutable (SPEC §4.2 rule 3). This adds one deliberate,
-- narrow exception so a payment entered by mistake can be removed outright
-- rather than leaving a reversal pair on the vendor's history.
--
-- The escape hatch is a transaction-local setting holding the id of the single
-- entry allowed to go. Scoping it to one id rather than a boolean means that
-- even inside the transaction that opened the hatch, nothing else can be
-- deleted by accident. `set_config(..., true)` is local, so it cannot leak to
-- the next transaction on a pooled connection.
--
-- Everything that decides *whether* a delete is allowed — how old the payment
-- is, who recorded it, whether a bank line points at it, whether the period is
-- closed — lives in the application, which can say why it refused. The trigger
-- is the backstop that keeps every other code path honest.
CREATE OR REPLACE FUNCTION assert_journal_entry_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('ledger.allow_entry_delete', true) = OLD."id" THEN
      RETURN OLD;
    END IF;
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
