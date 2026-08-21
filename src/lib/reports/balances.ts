import type { AccountSubtype, AccountType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { money, type Money } from "@/lib/money";
import { normalBalance } from "@/lib/ledger/accounts";

/**
 * Account balances for a period. Everything in Phase 5 is built on this, so
 * every report reads the same ledger the same way — a report that disagrees
 * with the Trial Balance is a bug, not a point of view.
 */

export type AccountBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  parentId: string | null;
  /** Positive on the account's normal side. */
  amount: Money;
  debit: Money;
  credit: Money;
};

export async function balancesByAccount(options: {
  companyId: string;
  /** Inclusive. Omit for "since the beginning of the books". */
  from?: Date | null;
  /** Inclusive. */
  to: Date;
  types?: AccountType[];
}): Promise<AccountBalanceRow[]> {
  const [accounts, grouped] = await Promise.all([
    prisma.account.findMany({
      where: {
        companyId: options.companyId,
        ...(options.types ? { type: { in: options.types } } : {}),
      },
      orderBy: { code: "asc" },
    }),
    prisma.journalLine.groupBy({
      by: ["accountId"],
      where: {
        entry: {
          companyId: options.companyId,
          date: { lte: options.to, ...(options.from ? { gte: options.from } : {}) },
        },
      },
      _sum: { debit: true, credit: true },
    }),
  ]);

  const totals = new Map(grouped.map((row) => [row.accountId, row._sum]));

  return accounts.map((account) => {
    const sums = totals.get(account.id);
    const debit = money(sums?.debit ?? 0);
    const credit = money(sums?.credit ?? 0);
    const net = debit.minus(credit);
    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      subtype: account.subtype,
      parentId: account.parentId,
      amount: normalBalance(account.type) === "DEBIT" ? net : net.negated(),
      debit,
      credit,
    };
  });
}

/** Net income for a period: income less expenses, from the ledger. */
export async function netIncomeForPeriod(options: {
  companyId: string;
  from?: Date | null;
  to: Date;
}): Promise<Money> {
  const rows = await balancesByAccount({ ...options, types: ["INCOME", "EXPENSE"] });
  return rows.reduce<Money>(
    (total, row) => (row.type === "INCOME" ? total.plus(row.amount) : total.minus(row.amount)),
    money(0),
  );
}
