import type { AccountSubtype, AccountType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { money, sum, type Money } from "@/lib/money";
import { normalBalance, TYPE_ORDER } from "./accounts";

/**
 * Trial Balance (SPEC §12.3) — every account with debit and credit columns and
 * totals that match. Built early because it is the first debugging tool: if
 * this does not balance, nothing downstream can be trusted.
 *
 * Every figure here is drillable in Phase 5; the row already carries the
 * accountId needed to open the lines behind it.
 */

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  debit: Money;
  credit: Money;
};

export type TrialBalance = {
  asOf: Date;
  from: Date | null;
  rows: TrialBalanceRow[];
  totalDebit: Money;
  totalCredit: Money;
  balanced: boolean;
};

export async function trialBalance(options: {
  companyId: string;
  asOf: Date;
  /** Optional period start. Omitted means "since the beginning of the books". */
  from?: Date | null;
  includeZeroRows?: boolean;
}): Promise<TrialBalance> {
  const { companyId, asOf } = options;
  const from = options.from ?? null;

  const grouped = await prisma.journalLine.groupBy({
    by: ["accountId"],
    where: {
      entry: {
        companyId,
        date: { lte: asOf, ...(from ? { gte: from } : {}) },
      },
    },
    _sum: { debit: true, credit: true },
  });

  const accounts = await prisma.account.findMany({
    where: { companyId },
    orderBy: [{ code: "asc" }],
  });

  const totals = new Map(grouped.map((row) => [row.accountId, row._sum]));

  const rows: TrialBalanceRow[] = [];
  for (const account of accounts) {
    const totalsForAccount = totals.get(account.id);
    const debitSum = money(totalsForAccount?.debit ?? 0);
    const creditSum = money(totalsForAccount?.credit ?? 0);
    const net = debitSum.minus(creditSum);

    if (net.isZero() && !options.includeZeroRows) continue;

    // One column per account, on its natural side — the convention every
    // accountant expects from a trial balance.
    rows.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      subtype: account.subtype,
      debit: net.isPositive() ? net : money(0),
      credit: net.isNegative() ? net.negated() : money(0),
    });
  }

  rows.sort((a, b) => {
    const byType = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
    return byType !== 0 ? byType : a.code.localeCompare(b.code);
  });

  const totalDebit = sum(rows.map((row) => row.debit));
  const totalCredit = sum(rows.map((row) => row.credit));

  return {
    asOf,
    from,
    rows,
    totalDebit,
    totalCredit,
    balanced: totalDebit.equals(totalCredit),
  };
}

/** Signed balance of one account, on its normal side (positive = normal). */
export async function accountBalance(options: {
  companyId: string;
  accountId: string;
  asOf: Date;
  from?: Date | null;
}): Promise<Money> {
  const account = await prisma.account.findFirstOrThrow({
    where: { id: options.accountId, companyId: options.companyId },
    select: { type: true },
  });

  const aggregate = await prisma.journalLine.aggregate({
    where: {
      accountId: options.accountId,
      entry: {
        companyId: options.companyId,
        date: { lte: options.asOf, ...(options.from ? { gte: options.from } : {}) },
      },
    },
    _sum: { debit: true, credit: true },
  });

  const net = money(aggregate._sum.debit ?? 0).minus(money(aggregate._sum.credit ?? 0));
  return normalBalance(account.type) === "DEBIT" ? net : net.negated();
}
