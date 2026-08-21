import type { AccountSubtype } from "@prisma/client";
import { money, type Money } from "@/lib/money";
import { balancesByAccount, type AccountBalanceRow } from "./balances";

/**
 * Profit & Loss (SPEC §12.1). Accrual basis, which is the required one: the
 * figures come from postings dated in the period, not from cash movements.
 *
 * Every row carries its accountId so the drill-down layer can open the journal
 * lines behind the number.
 */

export type PlSection = {
  key: "INCOME" | "COST_OF_SALES" | "EXPENSES" | "OTHER_INCOME" | "OTHER_EXPENSE";
  label: string;
  rows: AccountBalanceRow[];
  total: Money;
};

export type ProfitAndLoss = {
  from: Date;
  to: Date;
  sections: PlSection[];
  income: Money;
  costOfSales: Money;
  grossProfit: Money;
  expenses: Money;
  operatingIncome: Money;
  otherIncome: Money;
  otherExpense: Money;
  netIncome: Money;
};

const SUBTYPE_SECTION: Partial<Record<AccountSubtype, PlSection["key"]>> = {
  INCOME: "INCOME",
  OTHER_INCOME: "OTHER_INCOME",
  COST_OF_SALES: "COST_OF_SALES",
  EXPENSE: "EXPENSES",
  OTHER_EXPENSE: "OTHER_EXPENSE",
};

const SECTION_LABELS: Record<PlSection["key"], string> = {
  INCOME: "Income",
  COST_OF_SALES: "Cost of sales",
  EXPENSES: "Expenses",
  OTHER_INCOME: "Other income",
  OTHER_EXPENSE: "Other expense",
};

export async function profitAndLoss(options: {
  companyId: string;
  from: Date;
  to: Date;
  includeZeroRows?: boolean;
}): Promise<ProfitAndLoss> {
  const rows = await balancesByAccount({
    companyId: options.companyId,
    from: options.from,
    to: options.to,
    types: ["INCOME", "EXPENSE"],
  });

  const visible = rows.filter((row) => options.includeZeroRows || !row.amount.isZero());

  const sections: PlSection[] = (
    ["INCOME", "COST_OF_SALES", "EXPENSES", "OTHER_INCOME", "OTHER_EXPENSE"] as const
  ).map((key) => {
    const sectionRows = visible.filter((row) => SUBTYPE_SECTION[row.subtype] === key);
    return {
      key,
      label: SECTION_LABELS[key],
      rows: sectionRows,
      total: sectionRows.reduce<Money>((total, row) => total.plus(row.amount), money(0)),
    };
  });

  const find = (key: PlSection["key"]) =>
    sections.find((section) => section.key === key)?.total ?? money(0);

  const income = find("INCOME");
  const costOfSales = find("COST_OF_SALES");
  const grossProfit = income.minus(costOfSales);
  const expenses = find("EXPENSES");
  const operatingIncome = grossProfit.minus(expenses);
  const otherIncome = find("OTHER_INCOME");
  const otherExpense = find("OTHER_EXPENSE");
  const netIncome = operatingIncome.plus(otherIncome).minus(otherExpense);

  return {
    from: options.from,
    to: options.to,
    sections,
    income,
    costOfSales,
    grossProfit,
    expenses,
    operatingIncome,
    otherIncome,
    otherExpense,
    netIncome,
  };
}
