import type { Prisma } from "@prisma/client";
import { money } from "@/lib/money";
import { formatAccountingDate } from "@/lib/dates";
import { PostingError } from "@/lib/errors";
import { reconciliationLock } from "@/lib/bank/reconcile";

/**
 * Same-day delete, shared by every document that can be erased (SPEC §4.2
 * rule 3 and its one exception).
 *
 * Posted entries are immutable. Editing reverses and reposts; that is the rule
 * and it does not bend. What this is for is the narrower thing: a document
 * recorded by mistake minutes ago, where a reversal pair on a vendor's history
 * is a worse record than no record at all.
 *
 * The window is deliberately mean — your own document, within a day, that
 * nothing has come to depend on, in an open period. Everything outside it
 * reverses. What a delete costs is real: nothing afterwards shows the document
 * existed except the audit row written at the time, which carries the whole of
 * it, and the gap it leaves in the journal numbering. Both are deliberate. A
 * missing entry number is the thread an auditor pulls.
 *
 * The rules live here rather than in each service so that the list deciding
 * whether to offer the button and the action deciding whether to obey it are
 * reading the same sentence — including the sentence itself, which is shown to
 * the person who clicked.
 */

/** How long after recording a document it can still be deleted outright. */
export const DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ErasableEntry = {
  id: string;
  entryNumber: number;
  date: Date;
  memo: string | null;
  postedAt: Date;
  createdByUserId: string | null;
  reversedByEntryId: string | null;
  lines: {
    lineNumber: number;
    accountId: string;
    debit: Prisma.Decimal;
    credit: Prisma.Decimal;
    description: string | null;
    customerId: string | null;
    vendorId: string | null;
    currency: string | null;
    fxRate: Prisma.Decimal | null;
    foreignAmount: Prisma.Decimal | null;
  }[];
};

export type ErasableInput = {
  /** "payment", "bill", "invoice" — used in the refusals, so it reads naturally. */
  noun: string;
  document: {
    createdAt: Date;
    /** Payments carry this; documents that are voided instead carry voidedAt. */
    reversedAt?: Date | null;
    voidedAt?: Date | null;
  };
  /**
   * The document's posting, or null when it has none. A document that never
   * posted — a draft — is not erased through here; it is simply deleted.
   */
  entry: Pick<ErasableEntry, "postedAt" | "date" | "createdByUserId" | "reversedByEntryId"> | null;
  /** How many entries exist for this document. More than one means something built on it. */
  postings: number;
  /** Bank lines pointing at this document or its entry. */
  bankMatchCount: number;
  booksClosedThrough: Date | null;
  userId: string;
  /**
   * The one rule that differs per document: a bill with a payment applied, an
   * invoice with a payment against it, a sales order already invoiced. Checked
   * before the generic rules, because it is the more useful thing to be told.
   */
  dependency?: string | null;
};

/**
 * Why this document cannot be deleted, or null if it can.
 *
 * The order is the order the reasons are worth hearing. "Already reversed"
 * beats "too old", because a reversed document is usually also old and the
 * reversal is the thing the reader has forgotten about.
 */
/** "an invoice", "a payment" — so the refusals read like sentences. */
function an(noun: string, capital = false): string {
  const article = /^[aeiou]/i.test(noun) ? "an" : "a";
  return `${capital ? article[0].toUpperCase() + article.slice(1) : article} ${noun}`;
}

export function whyNotErasable(input: ErasableInput): string | null {
  const { document, entry, noun } = input;

  if (document.reversedAt) {
    return `This ${noun} has already been reversed. The reversal is the record of the correction — deleting it now would hide that anything happened.`;
  }
  if (document.voidedAt) {
    return `This ${noun} has already been voided. The void is the record of the correction — deleting it now would hide that anything happened.`;
  }
  if (input.dependency) return input.dependency;

  if (!entry) {
    return `No posting was found for this ${noun}, so there is nothing to unwind safely.`;
  }
  if (entry.reversedByEntryId) return `This ${noun}'s posting has already been reversed.`;

  if (Date.now() - entry.postedAt.getTime() > DELETE_WINDOW_MS) {
    return `${an(noun, true)} can only be deleted within 24 hours of being recorded. Reverse it instead, which keeps both the ${noun} and the correction on the record.`;
  }
  if (!entry.createdByUserId || entry.createdByUserId !== input.userId) {
    return `Only the person who recorded ${an(noun)} can delete it. Reverse it instead.`;
  }
  if (input.bankMatchCount > 0) {
    return `A bank line is matched to this ${noun}. Unmatch it first, or reverse the ${noun} instead.`;
  }
  if (input.booksClosedThrough && entry.date <= input.booksClosedThrough) {
    return `The books are closed through ${formatAccountingDate(
      input.booksClosedThrough,
    )}. ${an(noun, true)} dated on or before that can only be reversed, never deleted.`;
  }
  // Last, because a reversed document also has two postings and "already
  // reversed" is the more useful thing to say. More than one posting otherwise
  // means something else has built on this document, and unwinding the first
  // would leave the ledger holding the rest.
  if (input.postings > 1) {
    return `This ${noun} has more than one posting against it. Reverse it instead.`;
  }

  return null;
}

/**
 * The entry, verbatim, for the audit row. The trail is append-only (SPEC §13),
 * so this is the only thing that will still know what was posted.
 */
export function snapshotEntry(entry: ErasableEntry) {
  return {
    id: entry.id,
    entryNumber: entry.entryNumber,
    date: entry.date.toISOString().slice(0, 10),
    memo: entry.memo,
    postedAt: entry.postedAt.toISOString(),
    lines: entry.lines.map((line) => ({
      lineNumber: line.lineNumber,
      accountId: line.accountId,
      debit: money(line.debit).toFixed(2),
      credit: money(line.credit).toFixed(2),
      description: line.description,
      customerId: line.customerId,
      vendorId: line.vendorId,
      currency: line.currency,
      fxRate: line.fxRate ? money(line.fxRate).toString() : null,
      foreignAmount: line.foreignAmount ? money(line.foreignAmount).toFixed(2) : null,
    })),
  };
}

/**
 * Deletes one posted entry, and only that one.
 *
 * The immutability trigger refuses every delete except the single entry id in
 * `ledger.allow_entry_delete`, set transaction-locally here. Scoping the hatch
 * to one id rather than a boolean means that even inside this transaction
 * nothing else can go — including anything a later bug might attempt while the
 * transaction is still open. `set_config(..., true)` is local, so it cannot
 * leak to the next transaction on a pooled connection.
 */
export async function eraseEntry(
  tx: Prisma.TransactionClient,
  entryId: string,
  companyId: string,
) {
  // Checked here rather than in each of the six delete services, because this
  // is the one function that destroys an entry. A signed-off statement whose
  // lines can still be deleted afterwards proves nothing (SPEC §8.4a).
  const reconciled = await reconciliationLock(companyId, entryId, tx);
  if (reconciled) throw new PostingError(reconciled);

  await tx.$executeRaw`SELECT set_config('ledger.allow_entry_delete', ${entryId}, true)`;
  await tx.journalEntry.delete({ where: { id: entryId } });
}

/** The include every eraser needs to build its snapshot. */
export const ERASE_ENTRY_INCLUDE = { lines: { orderBy: { lineNumber: "asc" } } } as const;
