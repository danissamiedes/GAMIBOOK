import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { formatAccountingDate } from "@/lib/dates";
import { money, type Money } from "@/lib/money";
import { writeAudit } from "@/lib/audit";

/**
 * Bank reconciliation (SPEC §8.4a) — does what the bank says agree with what
 * the books say, and if not, which entries account for the gap?
 *
 * This is a different question from matching, which SPEC §8.4 already covers.
 * Matching asks "what does this statement line correspond to". Reconciliation
 * asks the harder one, and the difference is the entries the statement does
 * *not* mention: a cheque written last week and not yet cashed is invisible to
 * a statement-row view, and is exactly what reconciliation exists to surface.
 *
 * So the unit here is the **journal line against the bank's GL account**, not
 * the imported statement row. Each line is either cleared — it appeared on this
 * statement — or outstanding.
 *
 * The arithmetic, which is the whole feature:
 *
 *     cleared balance = opening balance + Σ(cleared lines)
 *     difference      = statement ending balance − cleared balance
 *
 * A reconciliation can only be completed when the difference is exactly zero.
 * "Near enough" is how a reconciliation stops being evidence of anything.
 */

/** How a bank account's own balance moves: a debit is money in. */
function movement(line: { debit: Prisma.Decimal; credit: Prisma.Decimal }): Money {
  return money(line.debit).minus(money(line.credit));
}

export type ReconcilableLine = {
  lineId: string;
  entryId: string;
  entryNumber: number;
  date: Date;
  description: string | null;
  memo: string | null;
  partyName: string | null;
  amount: Money;
  cleared: boolean;
  /** True when an earlier, completed reconciliation already cleared it. */
  clearedElsewhere: boolean;
};

export type ReconciliationView = {
  reconciliation: {
    id: string;
    bankAccountId: string;
    statementDate: Date;
    statementEndingBalance: Money;
    openingBalance: Money;
    status: "IN_PROGRESS" | "COMPLETED";
  };
  lines: ReconcilableLine[];
  clearedTotal: Money;
  clearedBalance: Money;
  difference: Money;
  outstandingTotal: Money;
  balanced: boolean;
};

/**
 * The closing cleared balance of the last completed reconciliation for an
 * account, which is where the next one starts. Zero when there has never been
 * one — the account opens from nothing, as it did in the ledger.
 */
export async function openingBalanceFor(
  companyId: string,
  bankAccountId: string,
  /**
   * Only count statements ending before this. Omit for "the latest one there
   * is" — which is what a screen asking where the *next* reconciliation starts
   * wants. Deliberately optional rather than a far-future sentinel: JavaScript's
   * maximum date is nine thousand years past what Postgres will accept, and
   * passing one fails at the driver rather than anywhere useful.
   */
  before: Date | null = null,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Money> {
  const previous = await client.bankReconciliation.findFirst({
    where: {
      companyId,
      bankAccountId,
      status: "COMPLETED",
      ...(before ? { statementDate: { lt: before } } : {}),
    },
    orderBy: { statementDate: "desc" },
    select: { statementEndingBalance: true },
  });
  // The previous statement's ending balance *is* the cleared balance: that is
  // what completing a reconciliation asserts.
  return previous ? money(previous.statementEndingBalance) : money(0);
}

/** Start a reconciliation, or return the one already open for this account. */
export async function openReconciliation(input: {
  companyId: string;
  bankAccountId: string;
  statementDate: Date;
  statementEndingBalance: Prisma.Decimal.Value;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const bankAccount = await tx.bankAccount.findFirst({
      where: { id: input.bankAccountId, companyId: input.companyId },
    });
    if (!bankAccount) throw new PostingError("Bank account not found in this company");

    // Two people ticking different copies of the same statement is not a state
    // worth modelling, so the second person joins the first one's work.
    const existing = await tx.bankReconciliation.findFirst({
      where: {
        companyId: input.companyId,
        bankAccountId: input.bankAccountId,
        status: "IN_PROGRESS",
      },
    });
    if (existing) {
      // The statement it is against can still be corrected while it is open.
      return tx.bankReconciliation.update({
        where: { id: existing.id },
        data: {
          statementDate: input.statementDate,
          statementEndingBalance: money(input.statementEndingBalance),
        },
      });
    }

    const completed = await tx.bankReconciliation.findFirst({
      where: {
        companyId: input.companyId,
        bankAccountId: input.bankAccountId,
        status: "COMPLETED",
        statementDate: { gte: input.statementDate },
      },
      orderBy: { statementDate: "desc" },
    });
    if (completed) {
      throw new PostingError(
        `This account is already reconciled through ${formatAccountingDate(
          completed.statementDate,
        )}. Choose a later statement date, or reopen that reconciliation first.`,
      );
    }

    return tx.bankReconciliation.create({
      data: {
        companyId: input.companyId,
        bankAccountId: input.bankAccountId,
        statementDate: input.statementDate,
        statementEndingBalance: money(input.statementEndingBalance),
        openingBalance: await openingBalanceFor(
          input.companyId,
          input.bankAccountId,
          input.statementDate,
          tx,
        ),
        startedByUserId: input.userId,
      },
    });
  });
}

/**
 * Everything the screen needs: the lines that could clear, which are ticked,
 * and the arithmetic.
 */
export async function reconciliationView(input: {
  companyId: string;
  reconciliationId: string;
}): Promise<ReconciliationView> {
  const reconciliation = await prisma.bankReconciliation.findFirst({
    where: { id: input.reconciliationId, companyId: input.companyId },
    include: { bankAccount: { select: { accountId: true } }, lines: true },
  });
  if (!reconciliation) throw new PostingError("Reconciliation not found in this company");

  const cleared = new Set(reconciliation.lines.map((line) => line.journalLineId));

  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: reconciliation.bankAccount.accountId,
      entry: {
        companyId: input.companyId,
        // Nothing after the statement's closing date can be on it.
        date: { lte: reconciliation.statementDate },
      },
    },
    include: {
      entry: { select: { id: true, entryNumber: true, date: true, memo: true } },
      customer: { select: { name: true } },
      vendor: { select: { name: true } },
      reconciled: { select: { reconciliationId: true } },
    },
    orderBy: [{ entry: { date: "asc" } }, { entry: { entryNumber: "asc" } }],
  });

  const rows: ReconcilableLine[] = lines
    .filter(
      (line) =>
        // Cleared on an earlier statement: settled business, not this one's.
        !line.reconciled || line.reconciled.reconciliationId === reconciliation.id,
    )
    .map((line) => ({
      lineId: line.id,
      entryId: line.entry.id,
      entryNumber: line.entry.entryNumber,
      date: line.entry.date,
      description: line.description,
      memo: line.entry.memo,
      partyName: line.customer?.name ?? line.vendor?.name ?? null,
      amount: movement(line),
      cleared: cleared.has(line.id),
      clearedElsewhere: false,
    }));

  const clearedTotal = rows
    .filter((row) => row.cleared)
    .reduce<Money>((total, row) => total.plus(row.amount), money(0));
  const outstandingTotal = rows
    .filter((row) => !row.cleared)
    .reduce<Money>((total, row) => total.plus(row.amount), money(0));

  const opening = money(reconciliation.openingBalance);
  const clearedBalance = opening.plus(clearedTotal);
  const difference = money(reconciliation.statementEndingBalance).minus(clearedBalance);

  return {
    reconciliation: {
      id: reconciliation.id,
      bankAccountId: reconciliation.bankAccountId,
      statementDate: reconciliation.statementDate,
      statementEndingBalance: money(reconciliation.statementEndingBalance),
      openingBalance: opening,
      status: reconciliation.status,
    },
    lines: rows,
    clearedTotal,
    clearedBalance,
    difference,
    outstandingTotal,
    balanced: difference.isZero(),
  };
}

/** Tick or untick one line. */
export async function setLineCleared(input: {
  companyId: string;
  reconciliationId: string;
  journalLineId: string;
  cleared: boolean;
}) {
  return prisma.$transaction(async (tx) => {
    const reconciliation = await tx.bankReconciliation.findFirst({
      where: { id: input.reconciliationId, companyId: input.companyId },
      include: { bankAccount: { select: { accountId: true } } },
    });
    if (!reconciliation) throw new PostingError("Reconciliation not found in this company");
    if (reconciliation.status === "COMPLETED") {
      throw new PostingError("This reconciliation is finished. Reopen it to change what cleared.");
    }

    // Prove the line belongs to this account, this company and this period —
    // the form is not the guard, and a stale page could name anything.
    const line = await tx.journalLine.findFirst({
      where: {
        id: input.journalLineId,
        accountId: reconciliation.bankAccount.accountId,
        entry: {
          companyId: input.companyId,
          date: { lte: reconciliation.statementDate },
        },
      },
      select: { id: true },
    });
    if (!line) throw new PostingError("That line is not on this statement's account and period");

    if (input.cleared) {
      await tx.bankReconciliationLine.upsert({
        where: { journalLineId: input.journalLineId },
        create: { reconciliationId: reconciliation.id, journalLineId: input.journalLineId },
        // Already cleared on another statement: the unique key stops the same
        // cash being signed off twice, and moving it would do just that.
        update: {},
      });
    } else {
      await tx.bankReconciliationLine.deleteMany({
        where: { journalLineId: input.journalLineId, reconciliationId: reconciliation.id },
      });
    }
  });
}

/** Tick or untick every line on the statement at once. */
export async function setAllCleared(input: {
  companyId: string;
  reconciliationId: string;
  cleared: boolean;
}) {
  const view = await reconciliationView({
    companyId: input.companyId,
    reconciliationId: input.reconciliationId,
  });
  if (view.reconciliation.status === "COMPLETED") {
    throw new PostingError("This reconciliation is finished. Reopen it to change what cleared.");
  }

  for (const line of view.lines) {
    if (line.cleared === input.cleared) continue;
    await setLineCleared({
      companyId: input.companyId,
      reconciliationId: input.reconciliationId,
      journalLineId: line.lineId,
      cleared: input.cleared,
    });
  }
}

/**
 * Sign the statement off. Refused unless the difference is exactly zero —
 * "near enough" is how a reconciliation stops being evidence of anything.
 */
export async function completeReconciliation(input: {
  companyId: string;
  reconciliationId: string;
  userId: string;
}) {
  const view = await reconciliationView({
    companyId: input.companyId,
    reconciliationId: input.reconciliationId,
  });
  if (view.reconciliation.status === "COMPLETED") {
    throw new PostingError("This reconciliation is already finished");
  }
  if (!view.balanced) {
    throw new PostingError(
      `The difference is ${view.difference.toFixed(2)}, not zero. Tick the lines the statement shows, or correct the ending balance.`,
    );
  }

  const done = await prisma.bankReconciliation.update({
    where: { id: input.reconciliationId },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
      completedByUserId: input.userId,
      reopenedAt: null,
    },
  });

  await writeAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: "reconciliation.completed",
    entityType: "BankReconciliation",
    entityId: done.id,
    summary: `Reconciled to ${formatAccountingDate(
      done.statementDate,
    )} at ${money(done.statementEndingBalance).toFixed(2)} — ${
      view.lines.filter((line) => line.cleared).length
    } lines cleared`,
    data: {
      statementDate: done.statementDate.toISOString().slice(0, 10),
      statementEndingBalance: money(done.statementEndingBalance).toFixed(2),
      openingBalance: view.reconciliation.openingBalance.toFixed(2),
      clearedTotal: view.clearedTotal.toFixed(2),
      outstandingTotal: view.outstandingTotal.toFixed(2),
    },
  });

  return done;
}

/**
 * Undo a completed reconciliation, freeing the entries it locked.
 *
 * Only the most recent one for an account, because a later reconciliation
 * opened from this one's ending balance: reopening an earlier statement would
 * leave every one after it resting on a figure nobody has agreed to.
 */
export async function reopenReconciliation(input: {
  companyId: string;
  reconciliationId: string;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const reconciliation = await tx.bankReconciliation.findFirst({
      where: { id: input.reconciliationId, companyId: input.companyId },
    });
    if (!reconciliation) throw new PostingError("Reconciliation not found in this company");
    if (reconciliation.status !== "COMPLETED") {
      throw new PostingError("That reconciliation is not finished, so there is nothing to reopen");
    }

    const later = await tx.bankReconciliation.findFirst({
      where: {
        companyId: input.companyId,
        bankAccountId: reconciliation.bankAccountId,
        statementDate: { gt: reconciliation.statementDate },
      },
      orderBy: { statementDate: "asc" },
    });
    if (later) {
      throw new PostingError(
        `A later statement (${formatAccountingDate(
          later.statementDate,
        )}) was reconciled after this one. Reopen that first — it starts from this one's balance.`,
      );
    }

    const reopened = await tx.bankReconciliation.update({
      where: { id: reconciliation.id },
      data: { status: "IN_PROGRESS", completedAt: null, reopenedAt: new Date() },
    });

    await writeAudit(
      {
        companyId: input.companyId,
        userId: input.userId,
        action: "reconciliation.reopened",
        entityType: "BankReconciliation",
        entityId: reconciliation.id,
        summary: `Reopened the reconciliation to ${formatAccountingDate(
          reconciliation.statementDate,
        )} — the entries it cleared can be changed again`,
      },
      tx,
    );

    return reopened;
  });
}

/**
 * Why a journal entry cannot be changed because of a reconciliation, or null.
 *
 * This is the lock a completed reconciliation buys: a signed-off statement
 * whose lines can still be edited afterwards proves nothing. Read by the
 * posting-level guards, so every path — edit, void, delete — refuses alike.
 */
export async function reconciliationLock(
  companyId: string,
  entryId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string | null> {
  const locked = await client.bankReconciliationLine.findFirst({
    where: {
      journalLine: { journalEntryId: entryId },
      reconciliation: { companyId, status: "COMPLETED" },
    },
    select: { reconciliation: { select: { statementDate: true } } },
  });
  if (!locked) return null;
  return `This entry was reconciled on the statement to ${formatAccountingDate(
    locked.reconciliation.statementDate,
  )}. Reopen that reconciliation to change it, or post a reversal.`;
}
