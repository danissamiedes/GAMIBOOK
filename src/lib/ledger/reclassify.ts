import type { JournalSourceType, Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { formatAccountingDate } from "@/lib/dates";
import { money, type Money } from "@/lib/money";
import { accountingDate, postJournalEntry, reverseJournalEntry } from "./post";

/**
 * Moving postings from one account to another (SPEC §18).
 *
 * A bookkeeper codes three months of fuel to Repairs, notices in March, and
 * needs it in Fuel — by the hundred, not one at a time. What they must not get
 * is an edit: a posted line is immutable (SPEC §4.2 rule 3), and quietly
 * rewriting its account would change the past under a trial balance somebody
 * has already signed.
 *
 * So a reclassification is a posting of its own. For each line it writes a
 * balanced entry that takes the amount out of the account it is in and puts it
 * in the account it belongs to — the same side as the original, so a credit
 * moves as a credit — and keeps a row saying which original line that entry
 * answers. The original stands; the account totals come out right; and the two
 * are joined, so the history reads forwards and backwards.
 *
 * **Dates.** Each entry is dated to the line it corrects, not to today. A July
 * mistake fixed in October belongs in July, or both months are wrong until
 * somebody notices. A single date for the whole batch is available for the
 * cases where that is what the accountant wants, and is recorded as such.
 */

/** What a line being considered for a move looks like on screen. */
export type ReclassifiableLine = {
  journalLineId: string;
  entryId: string;
  entryNumber: number;
  date: Date;
  sourceType: JournalSourceType;
  /** The document's own reference, where it has one; the entry number if not. */
  reference: string;
  description: string;
  debit: Money;
  credit: Money;
  /** Debit less credit: what moving this line would shift, signed. */
  amount: Money;
  /** Null when the line can be moved; a sentence when it cannot. */
  blockedReason: string | null;
};

export type LineFilters = {
  companyId: string;
  accountId: string;
  from: Date;
  to: Date;
  /** The kind of document the posting came from. */
  sourceType?: JournalSourceType | null;
  /** Matched against the document reference and the entry number. */
  reference?: string | null;
  /** Matched against the line's description and the entry's memo. */
  description?: string | null;
};

/** The most lines one screen will consider, so a wide filter cannot hang. */
export const LINE_LIMIT = 500;

/**
 * The lines in an account over a period, each with whether it may be moved.
 *
 * Ineligible lines are returned rather than hidden. "Why can I not see the
 * October invoice?" is a worse question to leave someone with than a row that
 * says, in place, that it was reconciled on a statement.
 */
export async function findReclassifiableLines(
  filters: LineFilters,
): Promise<{ lines: ReclassifiableLine[]; truncated: boolean }> {
  const description = filters.description?.trim();

  const rows = await prisma.journalLine.findMany({
    where: {
      accountId: filters.accountId,
      entry: {
        companyId: filters.companyId,
        date: { gte: accountingDate(filters.from), lte: accountingDate(filters.to) },
        ...(filters.sourceType ? { sourceType: filters.sourceType } : {}),
      },
      ...(description
        ? {
            OR: [
              { description: { contains: description, mode: "insensitive" } },
              { entry: { memo: { contains: description, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    orderBy: [{ entry: { date: "asc" } }, { entry: { entryNumber: "asc" } }, { lineNumber: "asc" }],
    take: LINE_LIMIT + 1,
    include: {
      entry: {
        select: {
          id: true,
          entryNumber: true,
          date: true,
          memo: true,
          sourceType: true,
          sourceId: true,
          reversedByEntryId: true,
        },
      },
      reconciled: {
        select: { reconciliation: { select: { status: true, statementDate: true } } },
      },
      reclassifiedBy: {
        where: { activeSourceLineId: { not: null } },
        select: { reclassification: { select: { toAccount: { select: { code: true, name: true } } } } },
      },
    },
  });

  const truncated = rows.length > LINE_LIMIT;
  const kept = truncated ? rows.slice(0, LINE_LIMIT) : rows;

  const references = await documentReferences(kept.map((row) => row.entry));

  const lines = kept.map((row) => {
    const debit = money(row.debit);
    const credit = money(row.credit);
    const moved = row.reclassifiedBy[0];
    const reconciled = row.reconciled?.reconciliation;

    let blockedReason: string | null = null;
    if (moved) {
      const target = moved.reclassification.toAccount;
      blockedReason = `Already moved to ${target.code} ${target.name}`;
    } else if (row.entry.reversedByEntryId) {
      blockedReason = "This entry was reversed — there is nothing left to move";
    } else if (reconciled?.status === "COMPLETED") {
      blockedReason = `Reconciled on the statement to ${formatAccountingDate(
        reconciled.statementDate,
      )}`;
    }

    return {
      journalLineId: row.id,
      entryId: row.entry.id,
      entryNumber: row.entry.entryNumber,
      date: row.entry.date,
      sourceType: row.entry.sourceType,
      reference: references.get(row.entry.id) ?? `JE-${row.entry.entryNumber}`,
      description: row.description ?? row.entry.memo ?? "",
      debit,
      credit,
      amount: debit.minus(credit),
      blockedReason,
    };
  });

  const reference = filters.reference?.trim().toLowerCase();
  return {
    lines: reference
      ? lines.filter((line) => line.reference.toLowerCase().includes(reference))
      : lines,
    truncated,
  };
}

/**
 * The reference a reader would recognise: the document's own number.
 *
 * Journal entries do not carry one — the number belongs to the invoice, the
 * bill, the expense — so they are fetched per kind, in one query each, for the
 * page's worth of rows rather than row by row.
 */
async function documentReferences(
  entries: { id: string; sourceType: JournalSourceType; sourceId: string | null }[],
): Promise<Map<string, string>> {
  const idsFor = (type: JournalSourceType) =>
    entries.filter((entry) => entry.sourceType === type && entry.sourceId).map((entry) => entry.sourceId!);

  const [expenses, invoices, workOrders, bankTransactions, billPayments] = await Promise.all([
    withIds(idsFor("EXPENSE"), (ids) =>
      prisma.expense.findMany({ where: { id: { in: ids } }, select: { id: true, reference: true } }),
    ),
    withIds(idsFor("INVOICE"), (ids) =>
      prisma.invoice.findMany({ where: { id: { in: ids } }, select: { id: true, invoiceNumber: true } }),
    ),
    withIds(idsFor("WORK_ORDER"), (ids) =>
      prisma.workOrder.findMany({
        where: { id: { in: ids } },
        select: { id: true, workOrderNumber: true },
      }),
    ),
    withIds(idsFor("BANK_TRANSACTION"), (ids) =>
      prisma.bankTransaction.findMany({
        where: { id: { in: ids } },
        select: { id: true, reference: true },
      }),
    ),
    withIds(idsFor("CONSULTANT_PAYMENT"), (ids) =>
      prisma.billPayment.findMany({
        where: { id: { in: ids } },
        select: { id: true, reference: true },
      }),
    ),
  ]);

  const byDocument = new Map<string, string>();
  for (const row of expenses) if (row.reference) byDocument.set(row.id, row.reference);
  for (const row of invoices) if (row.invoiceNumber) byDocument.set(row.id, row.invoiceNumber);
  for (const row of workOrders) if (row.workOrderNumber) byDocument.set(row.id, row.workOrderNumber);
  for (const row of bankTransactions) if (row.reference) byDocument.set(row.id, row.reference);
  for (const row of billPayments) if (row.reference) byDocument.set(row.id, row.reference);

  // Only entries whose document had a reference are in the map; the caller
  // falls back to the entry's own number for the rest.
  const byEntry = new Map<string, string>();
  for (const entry of entries) {
    const reference = entry.sourceId ? byDocument.get(entry.sourceId) : undefined;
    if (reference) byEntry.set(entry.id, reference);
  }
  return byEntry;
}

async function withIds<T>(ids: string[], query: (ids: string[]) => Promise<T[]>): Promise<T[]> {
  if (ids.length === 0) return [];
  return query([...new Set(ids)]);
}

export type ReclassifyInput = {
  companyId: string;
  fromAccountId: string;
  toAccountId: string;
  journalLineIds: string[];
  /** One date for every entry. Omitted, each entry takes its own line's date. */
  date?: Date | null;
  reason?: string | null;
  userId?: string | null;
  role?: Role | null;
};

export type ReclassifyResult = {
  reclassificationId: string;
  movedCount: number;
  totalDebit: Money;
  totalCredit: Money;
};

/**
 * Move the chosen lines, or move none of them.
 *
 * Everything runs in one transaction: a batch that fails halfway would leave
 * an account half corrected, which is worse than one that was never touched,
 * because nobody would know which half.
 */
export async function reclassifyLines(input: ReclassifyInput): Promise<ReclassifyResult> {
  const ids = [...new Set(input.journalLineIds)];
  if (ids.length === 0) throw new PostingError("Choose at least one transaction to reclassify");
  if (input.fromAccountId === input.toAccountId) {
    throw new PostingError("The destination account must be different from the source account");
  }

  return prisma.$transaction(async (tx) => {
    const [from, to] = await Promise.all([
      tx.account.findFirst({
        where: { id: input.fromAccountId, companyId: input.companyId },
        select: { id: true, code: true, name: true, isSystem: true },
      }),
      tx.account.findFirst({
        where: { id: input.toAccountId, companyId: input.companyId },
        select: { id: true, code: true, name: true, isSystem: true, isActive: true },
      }),
    ]);
    if (!from) throw new PostingError("Source account not found in this company");
    if (!to) throw new PostingError("Destination account not found in this company");
    if (!to.isActive) throw new PostingError("That destination account is archived");
    // A/R, A/P and retained earnings are the ledger's own working accounts.
    // Their balances are built from documents and the year's close, so moving
    // a line out of one by hand breaks the thing that reconciles them.
    if (from.isSystem || to.isSystem) {
      throw new PostingError(
        "System accounts (A/R, A/P, retained earnings) cannot be reclassified by hand — correct the document instead",
      );
    }

    const lines = await tx.journalLine.findMany({
      where: { id: { in: ids }, accountId: from.id, entry: { companyId: input.companyId } },
      include: {
        entry: { select: { id: true, entryNumber: true, date: true, memo: true, reversedByEntryId: true } },
        reconciled: {
          select: { reconciliation: { select: { status: true, statementDate: true } } },
        },
      },
      orderBy: [{ entry: { date: "asc" } }, { lineNumber: "asc" }],
    });

    // Asked to move something that is not in this account, or not in this
    // company at all: that is a stale page or a tampered form, and either way
    // the honest answer is to post nothing.
    if (lines.length !== ids.length) {
      throw new PostingError(
        "Some of those transactions are no longer in that account — reload the page and try again",
      );
    }

    for (const line of lines) {
      if (line.entry.reversedByEntryId) {
        throw new PostingError(
          `Entry ${line.entry.entryNumber} has been reversed — there is nothing left to move`,
        );
      }
      const reconciled = line.reconciled?.reconciliation;
      if (reconciled?.status === "COMPLETED") {
        throw new PostingError(
          `Entry ${line.entry.entryNumber} was reconciled on the statement to ${formatAccountingDate(
            reconciled.statementDate,
          )}. Reopen that reconciliation first.`,
        );
      }
    }

    // Already moved, and still moved: the unique index would refuse this
    // anyway — this is the same refusal with a sentence attached, and it is
    // what stops a double-clicked button posting the batch twice.
    const already = await tx.reclassificationLine.findMany({
      where: { sourceJournalLineId: { in: ids }, activeSourceLineId: { not: null } },
      select: { sourceJournalLineId: true },
    });
    if (already.length > 0) {
      throw new PostingError(
        already.length === ids.length
          ? "Those transactions have already been reclassified"
          : `${already.length} of those transactions have already been reclassified — reload the page`,
      );
    }

    const reason = input.reason?.trim() || null;
    const batchDate = input.date ? accountingDate(input.date) : null;

    const reclassification = await tx.reclassification.create({
      data: {
        companyId: input.companyId,
        fromAccountId: from.id,
        toAccountId: to.id,
        reason,
        postedOnDate: batchDate,
        createdByUserId: input.userId ?? null,
      },
      select: { id: true },
    });

    let totalDebit = money(0);
    let totalCredit = money(0);

    for (const line of lines) {
      const debit = money(line.debit);
      const credit = money(line.credit);
      totalDebit = totalDebit.plus(debit);
      totalCredit = totalCredit.plus(credit);

      // The destination takes the line's own side, and the source gives it
      // back on the other: a credit moves as a credit, which is the whole of
      // "do not assume every posting is a debit".
      const carried = {
        description: `Reclassified: ${line.description ?? line.entry.memo ?? ""}`.trim(),
        customerId: line.customerId,
        vendorId: line.vendorId,
        currency: line.currency,
        fxRate: line.fxRate,
        foreignAmount: line.foreignAmount,
      };

      const entry = await postJournalEntry(
        {
          companyId: input.companyId,
          date: batchDate ?? line.entry.date,
          memo: `Reclassified from ${from.code} ${from.name} to ${to.code} ${to.name}${
            reason ? ` — ${reason}` : ""
          }`,
          sourceType: "RECLASSIFICATION",
          sourceId: reclassification.id,
          userId: input.userId,
          role: input.role,
          lines: [
            { accountId: to.id, debit, credit, ...carried },
            { accountId: from.id, debit: credit, credit: debit, ...carried },
          ],
        },
        tx,
      );

      await tx.reclassificationLine.create({
        data: {
          reclassificationId: reclassification.id,
          sourceJournalLineId: line.id,
          activeSourceLineId: line.id,
          journalEntryId: entry.id,
          debit,
          credit,
        },
      });
    }

    await writeAudit(
      {
        companyId: input.companyId,
        userId: input.userId,
        action: "reclassification.posted",
        entityType: "Reclassification",
        entityId: reclassification.id,
        summary: `${lines.length} postings moved from ${from.code} ${from.name} to ${to.code} ${to.name}${
          reason ? ` — ${reason}` : ""
        }`,
        data: {
          fromAccountId: from.id,
          toAccountId: to.id,
          journalLineIds: ids,
          totalDebit: totalDebit.toFixed(2),
          totalCredit: totalCredit.toFixed(2),
          date: batchDate ? formatAccountingDate(batchDate) : "each line's own date",
        },
      },
      tx,
    );

    return {
      reclassificationId: reclassification.id,
      movedCount: lines.length,
      totalDebit,
      totalCredit,
    };
  });
}

/**
 * Undo a reclassification by reversing every entry it posted.
 *
 * Reversal, not deletion: the move happened, and the record of it stays. Each
 * reversal is dated to the entry it reverses, for the same reason the move
 * was dated to the line it corrected. Once reversed, the original lines are
 * free to be moved again — somewhere else, presumably.
 */
export async function reverseReclassification(input: {
  companyId: string;
  reclassificationId: string;
  userId?: string | null;
  role?: Role | null;
}): Promise<{ reversedCount: number }> {
  return prisma.$transaction(async (tx) => {
    const batch = await tx.reclassification.findFirst({
      where: { id: input.reclassificationId, companyId: input.companyId },
      include: {
        lines: { include: { journalEntry: { select: { id: true, date: true, entryNumber: true } } } },
        fromAccount: { select: { code: true, name: true } },
        toAccount: { select: { code: true, name: true } },
      },
    });
    if (!batch) throw new PostingError("Reclassification not found in this company");
    if (batch.reversedAt) throw new PostingError("This reclassification has already been reversed");

    for (const line of batch.lines) {
      const reversal = await reverseJournalEntry(
        {
          companyId: input.companyId,
          entryId: line.journalEntry.id,
          date: line.journalEntry.date,
          memo: `Reversal of reclassification ${batch.fromAccount.code} → ${batch.toAccount.code}`,
          userId: input.userId,
          role: input.role,
        },
        tx,
      );
      await tx.reclassificationLine.update({
        where: { id: line.id },
        // The source line is released here: clearing it is what allows the
        // posting to be reclassified again.
        data: { reversalEntryId: reversal.id, activeSourceLineId: null },
      });
    }

    await tx.reclassification.update({
      where: { id: batch.id },
      data: { reversedAt: new Date(), reversedByUserId: input.userId ?? null },
    });

    await writeAudit(
      {
        companyId: input.companyId,
        userId: input.userId,
        action: "reclassification.reversed",
        entityType: "Reclassification",
        entityId: batch.id,
        summary: `${batch.lines.length} postings moved back to ${batch.fromAccount.code} ${batch.fromAccount.name}`,
      },
      tx,
    );

    return { reversedCount: batch.lines.length };
  });
}

/** The batches this company has posted, newest first (SPEC §18). */
export async function listReclassifications(companyId: string, take = 50) {
  return prisma.reclassification.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    take,
    include: {
      fromAccount: { select: { code: true, name: true } },
      toAccount: { select: { code: true, name: true } },
      createdBy: { select: { name: true, email: true } },
      lines: { select: { debit: true, credit: true } },
    },
  });
}

export type ReclassificationSummary = Awaited<ReturnType<typeof listReclassifications>>[number];

/** Total moved by a batch, which is the debit side plus the credit side. */
export function batchTotal(lines: { debit: Prisma.Decimal; credit: Prisma.Decimal }[]): Money {
  return lines.reduce((total, line) => total.plus(money(line.debit)).plus(money(line.credit)), money(0));
}
