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

export type PlannedBatch = {
  reclassificationId: string;
  plannedCount: number;
  totalDebit: Money;
  totalCredit: Money;
};

/** How many postings one request will attempt before handing back. */
export const RECLASSIFY_CHUNK = 50;

/**
 * How long one request keeps posting before handing back.
 *
 * Fifteen seconds short of the function's minute, for the same reason the
 * expense import counts the clock: how long a posting takes depends on the
 * distance to the database, so a fixed number of rows per request is a guess
 * that is wrong on a bad day — and being wrong means a killed function.
 */
export const RECLASSIFY_BUDGET_MS = 45_000;

export type RunProgress = {
  /** Postings dealt with by this request. */
  done: number;
  /** Postings still waiting. */
  remaining: number;
  /** True when there is nothing left to do. */
  finished: boolean;
};

/**
 * Settle what will move, and reserve it — without posting anything yet.
 *
 * Posting is the slow part: each line is an entry, an entry is a couple of
 * dozen round trips, and a few hundred of them will not fit in one
 * transaction (20s) or one function (60s). So the decision and the work are
 * separated. This is the decision: every check runs here, against every line,
 * and the batch is written down with its lines reserved and no entries on
 * them. Nothing has moved in the ledger when this returns.
 *
 * Reserving is what makes it safe to leave: the lines are claimed by the
 * unique index, so nobody else can move them while this batch is part-posted,
 * and a batch that is never finished can be picked up again or undone, but
 * cannot be silently posted twice.
 */
export async function planReclassification(input: ReclassifyInput): Promise<PlannedBatch> {
  const ids = [...new Set(input.journalLineIds)];
  if (ids.length === 0) throw new PostingError("Choose at least one transaction to reclassify");
  if (input.fromAccountId === input.toAccountId) {
    throw new PostingError("The destination account must be different from the source account");
  }

  return prisma.$transaction(async (tx) => {
    const [from, to, company] = await Promise.all([
      tx.account.findFirst({
        where: { id: input.fromAccountId, companyId: input.companyId },
        select: { id: true, code: true, name: true, isSystem: true },
      }),
      tx.account.findFirst({
        where: { id: input.toAccountId, companyId: input.companyId },
        select: { id: true, code: true, name: true, isSystem: true, isActive: true },
      }),
      tx.company.findUniqueOrThrow({
        where: { id: input.companyId },
        select: { booksClosedThrough: true },
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
        entry: { select: { id: true, entryNumber: true, date: true, reversedByEntryId: true } },
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
    // what stops a double-clicked button planning the batch twice.
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

    // The closed-period gate, asked of the whole batch before any of it
    // posts. `postJournalEntry` asks it again of every entry — that is the
    // guarantee — but asking here is what keeps the promise that a batch
    // refuses whole rather than posting the half that happened to be open.
    const closed = company.booksClosedThrough;
    if (closed && input.role !== "OWNER") {
      const blocked = lines.filter((line) => (batchDate ?? line.entry.date) <= closed);
      if (blocked.length > 0) {
        throw new PostingError(
          `The books are closed through ${formatAccountingDate(closed)}, and ${
            blocked.length === lines.length ? "these postings fall" : `${blocked.length} of these postings fall`
          } on or before that date. Only an owner can post there.`,
        );
      }
    }

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

    await tx.reclassificationLine.createMany({
      data: lines.map((line) => ({
        reclassificationId: reclassification.id,
        sourceJournalLineId: line.id,
        activeSourceLineId: line.id,
        debit: line.debit,
        credit: line.credit,
      })),
    });

    const totalDebit = lines.reduce((total, line) => total.plus(money(line.debit)), money(0));
    const totalCredit = lines.reduce((total, line) => total.plus(money(line.credit)), money(0));

    await writeAudit(
      {
        companyId: input.companyId,
        userId: input.userId,
        action: "reclassification.planned",
        entityType: "Reclassification",
        entityId: reclassification.id,
        summary: `${lines.length} postings to move from ${from.code} ${from.name} to ${to.code} ${to.name}${
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
      plannedCount: lines.length,
      totalDebit,
      totalCredit,
    };
  });
}

/**
 * Post as much of a planned batch as the clock allows, and say what is left.
 *
 * Each posting is its own small transaction — the entry and the link to the
 * line it answers, together, so a line is never marked moved without the
 * entry that moved it. The batch as a whole is no longer one transaction,
 * because it cannot be; what replaces that guarantee is this: every check ran
 * at planning time, the lines are reserved, and a batch that stops halfway
 * says so on its own page, where it can be finished or undone as a unit.
 *
 * Calling it again after it returns is how the rest gets done, and calling it
 * on a finished batch does nothing.
 */
export async function postReclassificationChunk(input: {
  companyId: string;
  reclassificationId: string;
  userId?: string | null;
  role?: Role | null;
  budgetMs?: number;
  limit?: number;
}): Promise<RunProgress> {
  const startedAt = Date.now();
  const budgetMs = input.budgetMs ?? RECLASSIFY_BUDGET_MS;

  const batch = await prisma.reclassification.findFirst({
    where: { id: input.reclassificationId, companyId: input.companyId },
    include: {
      fromAccount: { select: { id: true, code: true, name: true } },
      toAccount: { select: { id: true, code: true, name: true } },
    },
  });
  if (!batch) throw new PostingError("Reclassification not found in this company");
  if (batch.reversalRequestedAt) throw new PostingError("This reclassification is being undone");

  const planned = await prisma.reclassificationLine.findMany({
    where: { reclassificationId: batch.id, journalEntryId: null, activeSourceLineId: { not: null } },
    take: (input.limit ?? RECLASSIFY_CHUNK) + 1,
    include: {
      sourceJournalLine: {
        include: { entry: { select: { date: true, memo: true } } },
      },
    },
  });

  const limit = input.limit ?? RECLASSIFY_CHUNK;
  const slice = planned.slice(0, limit);
  const memo = `Reclassified from ${batch.fromAccount.code} ${batch.fromAccount.name} to ${batch.toAccount.code} ${batch.toAccount.name}${
    batch.reason ? ` — ${batch.reason}` : ""
  }`;

  let done = 0;
  for (const row of slice) {
    // Always do one, so no budget can stall a batch; after that, stop while
    // there is time left to answer rather than be killed mid-posting.
    if (done > 0 && Date.now() - startedAt >= budgetMs) break;

    const line = row.sourceJournalLine;
    const debit = money(line.debit);
    const credit = money(line.credit);
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

    await prisma.$transaction(async (tx) => {
      const entry = await postJournalEntry(
        {
          companyId: input.companyId,
          date: batch.postedOnDate ?? line.entry.date,
          memo,
          sourceType: "RECLASSIFICATION",
          sourceId: batch.id,
          userId: input.userId,
          role: input.role,
          lines: [
            { accountId: batch.toAccount.id, debit, credit, ...carried },
            { accountId: batch.fromAccount.id, debit: credit, credit: debit, ...carried },
          ],
        },
        tx,
      );
      await tx.reclassificationLine.update({
        where: { id: row.id },
        data: { journalEntryId: entry.id },
      });
    });
    done += 1;
  }

  const remaining = await prisma.reclassificationLine.count({
    where: { reclassificationId: batch.id, journalEntryId: null, activeSourceLineId: { not: null } },
  });

  if (remaining === 0 && !batch.completedAt) {
    const moved = await prisma.reclassificationLine.count({
      where: { reclassificationId: batch.id, journalEntryId: { not: null } },
    });
    await prisma.reclassification.update({
      where: { id: batch.id },
      data: { completedAt: new Date() },
    });
    await writeAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: "reclassification.posted",
      entityType: "Reclassification",
      entityId: batch.id,
      summary: `${moved} postings moved from ${batch.fromAccount.code} ${batch.fromAccount.name} to ${batch.toAccount.code} ${batch.toAccount.name}`,
    });
  }

  return { done, remaining, finished: remaining === 0 };
}

export type ReclassifyResult = {
  reclassificationId: string;
  movedCount: number;
  totalDebit: Money;
  totalCredit: Money;
};

/**
 * Plan a batch and post all of it, however long that takes.
 *
 * What the screen does in chunks, in one call — for a handful of lines, for
 * a script, and for the tests that describe what the two halves add up to.
 */
export async function reclassifyLines(input: ReclassifyInput): Promise<ReclassifyResult> {
  const planned = await planReclassification(input);

  for (;;) {
    const progress = await postReclassificationChunk({
      companyId: input.companyId,
      reclassificationId: planned.reclassificationId,
      userId: input.userId,
      role: input.role,
      budgetMs: Number.POSITIVE_INFINITY,
    });
    if (progress.finished) break;
    // A chunk that posted nothing while work remains would loop forever.
    if (progress.done === 0) {
      throw new PostingError("The reclassification stopped before it finished");
    }
  }

  return {
    reclassificationId: planned.reclassificationId,
    movedCount: planned.plannedCount,
    totalDebit: planned.totalDebit,
    totalCredit: planned.totalCredit,
  };
}

/**
 * Ask for a batch to be undone.
 *
 * Lines that were only planned are released here and now — there is nothing
 * to reverse, and holding a reservation over a posting nobody moved would
 * keep it out of the next attempt for no reason. Entries that did post are
 * reversed by the chunks that follow.
 */
export async function requestReclassificationReversal(input: {
  companyId: string;
  reclassificationId: string;
  userId?: string | null;
}): Promise<{ toReverse: number; released: number }> {
  return prisma.$transaction(async (tx) => {
    const batch = await tx.reclassification.findFirst({
      where: { id: input.reclassificationId, companyId: input.companyId },
      select: { id: true, reversedAt: true },
    });
    if (!batch) throw new PostingError("Reclassification not found in this company");
    if (batch.reversedAt) throw new PostingError("This reclassification has already been reversed");

    const released = await tx.reclassificationLine.updateMany({
      where: { reclassificationId: batch.id, journalEntryId: null },
      data: { activeSourceLineId: null },
    });
    const toReverse = await tx.reclassificationLine.count({
      where: { reclassificationId: batch.id, journalEntryId: { not: null }, reversalEntryId: null },
    });

    await tx.reclassification.update({
      where: { id: batch.id },
      data: {
        reversalRequestedAt: new Date(),
        reversedByUserId: input.userId ?? null,
        // Nothing posted, so there is nothing to reverse and the batch is
        // finished the moment it is asked for.
        ...(toReverse === 0 ? { reversedAt: new Date() } : {}),
      },
    });

    return { toReverse, released: released.count };
  });
}

/**
 * Reverse as many of a batch's entries as the clock allows.
 *
 * Each reversal is dated to the entry it reverses, for the same reason the
 * move was dated to the line it corrected, and releases that line so the
 * posting can be moved again — somewhere else, presumably.
 */
export async function reverseReclassificationChunk(input: {
  companyId: string;
  reclassificationId: string;
  userId?: string | null;
  role?: Role | null;
  budgetMs?: number;
  limit?: number;
}): Promise<RunProgress> {
  const startedAt = Date.now();
  const budgetMs = input.budgetMs ?? RECLASSIFY_BUDGET_MS;

  const batch = await prisma.reclassification.findFirst({
    where: { id: input.reclassificationId, companyId: input.companyId },
    include: {
      fromAccount: { select: { code: true, name: true } },
      toAccount: { select: { code: true, name: true } },
    },
  });
  if (!batch) throw new PostingError("Reclassification not found in this company");
  if (!batch.reversalRequestedAt) throw new PostingError("This reclassification is not being undone");

  const pending = await prisma.reclassificationLine.findMany({
    where: { reclassificationId: batch.id, journalEntryId: { not: null }, reversalEntryId: null },
    take: input.limit ?? RECLASSIFY_CHUNK,
    include: { journalEntry: { select: { id: true, date: true } } },
  });

  let done = 0;
  for (const row of pending) {
    if (done > 0 && Date.now() - startedAt >= budgetMs) break;
    const entry = row.journalEntry;
    if (!entry) continue;

    await prisma.$transaction(async (tx) => {
      const reversal = await reverseJournalEntry(
        {
          companyId: input.companyId,
          entryId: entry.id,
          date: entry.date,
          memo: `Reversal of reclassification ${batch.fromAccount.code} → ${batch.toAccount.code}`,
          userId: input.userId,
          role: input.role,
        },
        tx,
      );
      await tx.reclassificationLine.update({
        where: { id: row.id },
        // The source line is released here: clearing it is what allows the
        // posting to be reclassified again.
        data: { reversalEntryId: reversal.id, activeSourceLineId: null },
      });
    });
    done += 1;
  }

  const remaining = await prisma.reclassificationLine.count({
    where: { reclassificationId: batch.id, journalEntryId: { not: null }, reversalEntryId: null },
  });

  if (remaining === 0 && !batch.reversedAt) {
    const reversed = await prisma.reclassificationLine.count({
      where: { reclassificationId: batch.id, reversalEntryId: { not: null } },
    });
    await prisma.reclassification.update({
      where: { id: batch.id },
      data: { reversedAt: new Date() },
    });
    await writeAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: "reclassification.reversed",
      entityType: "Reclassification",
      entityId: batch.id,
      summary: `${reversed} postings moved back to ${batch.fromAccount.code} ${batch.fromAccount.name}`,
    });
  }

  return { done, remaining, finished: remaining === 0 };
}

/** Ask for a batch to be undone, and see it through. */
export async function reverseReclassification(input: {
  companyId: string;
  reclassificationId: string;
  userId?: string | null;
  role?: Role | null;
}): Promise<{ reversedCount: number }> {
  const asked = await requestReclassificationReversal(input);

  let reversed = 0;
  for (;;) {
    const progress = await reverseReclassificationChunk({
      ...input,
      budgetMs: Number.POSITIVE_INFINITY,
    });
    reversed += progress.done;
    if (progress.finished) break;
    if (progress.done === 0) {
      throw new PostingError("The reversal stopped before it finished");
    }
  }

  return { reversedCount: reversed || asked.toReverse };
}

/** Where a batch has got to, for the page that has to say so. */
export async function reclassificationProgress(companyId: string, reclassificationId: string) {
  const [planned, posted, reversed] = await Promise.all([
    prisma.reclassificationLine.count({
      where: {
        reclassificationId,
        reclassification: { companyId },
        journalEntryId: null,
        activeSourceLineId: { not: null },
      },
    }),
    prisma.reclassificationLine.count({
      where: { reclassificationId, reclassification: { companyId }, journalEntryId: { not: null } },
    }),
    prisma.reclassificationLine.count({
      where: {
        reclassificationId,
        reclassification: { companyId },
        reversalEntryId: { not: null },
      },
    }),
  ]);
  return { planned, posted, reversed };
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
