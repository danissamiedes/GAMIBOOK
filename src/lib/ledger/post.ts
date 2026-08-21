import type { JournalSourceType, Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { money, sum, toCents } from "@/lib/money";
import { SYSTEM_ACCOUNTS } from "./accounts";

/**
 * THE posting function (SPEC §4.2 rule 5).
 *
 * No other code writes a JournalLine. Documents, imports, bulk operations and
 * the bank matcher all call this. If you are about to write `prisma.journalLine
 * .create` somewhere else, that is the bug.
 *
 * Everything it enforces is also enforced by database constraints and triggers
 * (see the phase2_ledger migration) — the checks here exist to produce a clear,
 * actionable error instead of a constraint violation.
 */

export type PostLineInput = {
  accountId: string;
  debit?: Prisma.Decimal.Value;
  credit?: Prisma.Decimal.Value;
  description?: string | null;
  customerId?: string | null;
  vendorId?: string | null;
  currency?: string | null;
  fxRate?: Prisma.Decimal.Value | null;
  foreignAmount?: Prisma.Decimal.Value | null;
};

export type PostJournalEntryInput = {
  companyId: string;
  /** An accounting date: no time, no zone. */
  date: Date;
  memo?: string | null;
  sourceType: JournalSourceType;
  sourceId?: string | null;
  lines: PostLineInput[];
  /** Who is posting. Their role decides whether a closed period blocks them. */
  userId?: string | null;
  role?: Role | null;
};

/** Strip any time component: accounting dates are plain dates (SPEC §13). */
export function accountingDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Allocate the next number for a company's sequence inside the caller's
 * transaction. `UPDATE ... RETURNING` takes a row lock, so two concurrent
 * posts serialise here and the sequence stays gap-free (SPEC §13).
 */
export async function allocateNumber(
  tx: Prisma.TransactionClient,
  companyId: string,
  kind: "JOURNAL_ENTRY" | "INVOICE" | "WORK_ORDER",
): Promise<{ value: number; formatted: string }> {
  const rows = await tx.$queryRaw<{ nextValue: number; prefix: string }[]>`
    UPDATE "NumberSequence"
       SET "nextValue" = "nextValue" + 1
     WHERE "companyId" = ${companyId} AND "kind"::text = ${kind}
    RETURNING "nextValue" - 1 AS "nextValue", "prefix"
  `;

  if (rows.length === 0) {
    throw new PostingError(`No ${kind} sequence configured for this company`);
  }
  const row = rows[0];
  return { value: Number(row.nextValue), formatted: `${row.prefix}${row.nextValue}` };
}

async function assertPeriodOpen(
  tx: Prisma.TransactionClient,
  companyId: string,
  date: Date,
  role: Role | null | undefined,
) {
  const company = await tx.company.findUnique({
    where: { id: companyId },
    select: { booksClosedThrough: true },
  });
  if (!company) throw new PostingError("Unknown company");
  if (!company.booksClosedThrough) return;

  if (date <= company.booksClosedThrough) {
    // SPEC §4.2 rule 4: only an OWNER may post into a closed period.
    if (role !== "OWNER") {
      throw new PostingError(
        `The books are closed through ${company.booksClosedThrough
          .toISOString()
          .slice(0, 10)}. Only an owner can post on or before that date.`,
      );
    }
  }
}

/**
 * Post a balanced journal entry. Returns the created entry with its lines.
 * Runs in the caller's transaction when one is supplied, so a document and its
 * posting either both happen or neither does (SPEC §13).
 */
export async function postJournalEntry(
  input: PostJournalEntryInput,
  client?: Prisma.TransactionClient,
) {
  const run = async (tx: Prisma.TransactionClient) => {
    const date = accountingDate(input.date);

    if (input.lines.length < 2) {
      throw new PostingError("A journal entry needs at least two lines");
    }

    await assertPeriodOpen(tx, input.companyId, date, input.role);

    // Accounts must belong to this company and be usable. One query, so a
    // borrowed account id from another company simply is not found.
    const accountIds = [...new Set(input.lines.map((line) => line.accountId))];
    const accounts = await tx.account.findMany({
      where: { id: { in: accountIds }, companyId: input.companyId },
      select: { id: true, isActive: true, code: true, name: true, systemKey: true },
    });
    const accountsById = new Map(accounts.map((account) => [account.id, account]));

    const normalised = input.lines.map((line, index) => {
      const account = accountsById.get(line.accountId);
      if (!account) {
        throw new PostingError(
          `Line ${index + 1}: account does not exist in this company`,
        );
      }
      if (!account.isActive) {
        throw new PostingError(
          `Line ${index + 1}: account ${account.code} ${account.name} is inactive`,
        );
      }

      const debit = toCents(money(line.debit ?? 0));
      const credit = toCents(money(line.credit ?? 0));

      if (debit.isNegative() || credit.isNegative()) {
        throw new PostingError(`Line ${index + 1}: amounts cannot be negative`);
      }
      if (debit.isZero() && credit.isZero()) {
        throw new PostingError(`Line ${index + 1}: needs a debit or a credit`);
      }
      if (!debit.isZero() && !credit.isZero()) {
        throw new PostingError(
          `Line ${index + 1}: a line is either a debit or a credit, never both`,
        );
      }

      // The party dimension is required on the control accounts, so aging is
      // built from the ledger rather than from document tables (SPEC §4.2).
      if (account.systemKey === SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE && !line.customerId) {
        throw new PostingError(`Line ${index + 1}: an A/R line must carry a customer`);
      }
      if (account.systemKey === SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE && !line.vendorId) {
        // Consultants are vendors with a kind (SPEC §6), so one party column
        // covers both sides of payables and A/P aging groups by it.
        throw new PostingError(`Line ${index + 1}: an A/P line must carry a vendor`);
      }

      return {
        lineNumber: index + 1,
        accountId: line.accountId,
        debit,
        credit,
        description: line.description ?? null,
        customerId: line.customerId ?? null,
        vendorId: line.vendorId ?? null,
        currency: line.currency ?? null,
        fxRate: line.fxRate ?? null,
        foreignAmount: line.foreignAmount ?? null,
      };
    });

    const debitTotal = sum(normalised.map((line) => line.debit));
    const creditTotal = sum(normalised.map((line) => line.credit));

    if (!debitTotal.equals(creditTotal)) {
      throw new PostingError(
        `Entry does not balance: debits ${debitTotal.toFixed(2)}, credits ${creditTotal.toFixed(
          2,
        )}, difference ${debitTotal.minus(creditTotal).toFixed(2)}`,
      );
    }
    if (debitTotal.isZero()) {
      throw new PostingError("An entry of zero posts nothing");
    }

    const { value: entryNumber } = await allocateNumber(tx, input.companyId, "JOURNAL_ENTRY");

    return tx.journalEntry.create({
      data: {
        companyId: input.companyId,
        entryNumber,
        date,
        memo: input.memo ?? null,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        createdByUserId: input.userId ?? null,
        lines: { create: normalised },
      },
      include: { lines: { orderBy: { lineNumber: "asc" } } },
    });
  };

  return client ? run(client) : prisma.$transaction(run);
}

/**
 * Reverse a posted entry (SPEC §4.2 rule 3): the same lines with debit and
 * credit swapped, dated per the reversal date. The original is never touched
 * beyond a pointer to its reversal.
 */
export async function reverseJournalEntry(
  input: {
    companyId: string;
    entryId: string;
    date: Date;
    memo?: string | null;
    userId?: string | null;
    role?: Role | null;
  },
  client?: Prisma.TransactionClient,
) {
  const run = async (tx: Prisma.TransactionClient) => {
    const original = await tx.journalEntry.findFirst({
      where: { id: input.entryId, companyId: input.companyId },
      include: { lines: { orderBy: { lineNumber: "asc" } } },
    });
    if (!original) throw new PostingError("Entry not found in this company");
    if (original.reversedByEntryId) throw new PostingError("This entry has already been reversed");

    const reversal = await postJournalEntry(
      {
        companyId: input.companyId,
        date: input.date,
        memo: input.memo ?? `Reversal of entry ${original.entryNumber}`,
        sourceType: original.sourceType,
        sourceId: original.sourceId,
        userId: input.userId,
        role: input.role,
        lines: original.lines.map((line) => ({
          accountId: line.accountId,
          debit: line.credit,
          credit: line.debit,
          description: line.description,
          customerId: line.customerId,
          vendorId: line.vendorId,
          currency: line.currency,
          fxRate: line.fxRate,
          foreignAmount: line.foreignAmount,
        })),
      },
      tx,
    );

    await tx.journalEntry.update({
      where: { id: original.id },
      data: { reversedByEntryId: reversal.id },
    });

    return reversal;
  };

  return client ? run(client) : prisma.$transaction(run);
}
