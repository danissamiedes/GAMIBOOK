import type { AccountSubtype, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalBalance } from "@/lib/ledger/accounts";
import { money, type Money } from "@/lib/money";
import type { PlSection } from "./profit-loss";

/**
 * Profit & Loss by month (SPEC §12.1).
 *
 * The same accrual-basis figures as the standard P&L, cut into one column per
 * month with the period total beside them. What it is for is the shape of a
 * year rather than its size: a rent line that doubles in March, a fee that
 * stopped in June, a quarter that carried the rest.
 *
 * Two things it is careful about.
 *
 * **The columns are the months the period actually covers**, not whole months
 * assumed from the endpoints. A period starting on the 15th has a first column
 * running from the 15th, and its header says so — otherwise the first column
 * quietly claims to be a month it only half is, and the columns no longer sum
 * to the total.
 *
 * **One scan, not one per column.** Twelve `balancesByAccount` calls would give
 * the same answer and read more like the rest of the reports, but this is a
 * report someone opens on a full year: one grouped query beats twelve
 * sequential ones. The types are joined in SQL so the database does not hand
 * back every line in the year.
 */

export type MonthColumn = {
  /** Inclusive. The first column starts at the report's own `from`. */
  from: Date;
  /** Inclusive. The last column ends at the report's own `to`. */
  to: Date;
  /** "Aug 2026", or "Aug 1–15, 2026" when the column is a part month. */
  label: string;
  /** Whether this column covers its whole calendar month. */
  whole: boolean;
};

/** A figure across the months, and its total. The total is summed, never re-queried. */
export type Series = {
  months: Money[];
  total: Money;
};

export type MonthlyRow = Series & {
  accountId: string;
  code: string;
  name: string;
  subtype: AccountSubtype;
};

export type MonthlySection = Series & {
  key: PlSection["key"];
  label: string;
  rows: MonthlyRow[];
};

export type ProfitAndLossByMonth = {
  from: Date;
  to: Date;
  months: MonthColumn[];
  sections: MonthlySection[];
  income: Series;
  costOfSales: Series;
  grossProfit: Series;
  expenses: Series;
  operatingIncome: Series;
  otherIncome: Series;
  otherExpense: Series;
  netIncome: Series;
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

const MONTH_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The columns a period covers, clipped to it at both ends. */
export function monthColumns(from: Date, to: Date): MonthColumn[] {
  if (to < from) return [];

  const columns: MonthColumn[] = [];
  let cursor = new Date(from);

  // 400 is a hard stop, not a limit anyone should meet: a P&L by month over
  // thirty years is a mistake, and an unbounded loop on a bad date is worse.
  while (cursor <= to && columns.length < 400) {
    const monthEnd = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0),
    );
    const monthStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1));
    const columnEnd = monthEnd < to ? monthEnd : to;
    const whole =
      cursor.getTime() === monthStart.getTime() && columnEnd.getTime() === monthEnd.getTime();

    columns.push({
      from: new Date(cursor),
      to: columnEnd,
      label: whole
        ? MONTH_YEAR.format(cursor)
        : `${DAY.format(cursor)}–${DAY.format(columnEnd)}, ${columnEnd.getUTCFullYear()}`,
      whole,
    });

    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }

  return columns;
}

const zeros = (count: number) => Array.from({ length: count }, () => money(0));

const seriesOf = (months: Money[]): Series => ({
  months,
  total: months.reduce<Money>((total, amount) => total.plus(amount), money(0)),
});

/** Element-wise across two series of the same length. */
const combine = (a: Series, b: Series, op: (x: Money, y: Money) => Money): Series =>
  seriesOf(a.months.map((amount, index) => op(amount, b.months[index])));

export async function profitAndLossByMonth(options: {
  companyId: string;
  from: Date;
  to: Date;
  includeZeroRows?: boolean;
}): Promise<ProfitAndLossByMonth> {
  const months = monthColumns(options.from, options.to);

  const [accounts, rows] = await Promise.all([
    prisma.account.findMany({
      where: { companyId: options.companyId, type: { in: ["INCOME", "EXPENSE"] } },
      orderBy: { code: "asc" },
    }),
    prisma.$queryRaw<
      { accountId: string; month: Date; debit: Prisma.Decimal; credit: Prisma.Decimal }[]
    >`
      SELECT l."accountId"                        AS "accountId",
             date_trunc('month', e."date")        AS month,
             SUM(l."debit")                       AS debit,
             SUM(l."credit")                      AS credit
      FROM "JournalLine" l
      JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
      JOIN "Account" a      ON a."id" = l."accountId"
      WHERE e."companyId" = ${options.companyId}
        AND e."date" >= ${options.from}::date
        AND e."date" <= ${options.to}::date
        AND a."type" IN ('INCOME', 'EXPENSE')
      GROUP BY 1, 2
    `,
  ]);

  // date_trunc gives the first of the month; the columns are keyed the same way
  // so a part-month column still finds its bucket.
  const columnOf = new Map(
    months.map((column, index) => [
      Date.UTC(column.from.getUTCFullYear(), column.from.getUTCMonth(), 1),
      index,
    ]),
  );

  const byAccount = new Map<string, Money[]>();
  for (const row of rows) {
    const month = new Date(row.month);
    const index = columnOf.get(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
    if (index === undefined) continue;

    const amounts = byAccount.get(row.accountId) ?? zeros(months.length);
    amounts[index] = amounts[index].plus(money(row.debit).minus(money(row.credit)));
    byAccount.set(row.accountId, amounts);
  }

  const all: MonthlyRow[] = accounts.map((account) => {
    const net = byAccount.get(account.id) ?? zeros(months.length);
    // Positive on the account's normal side, as everywhere else.
    const signed =
      normalBalance(account.type) === "DEBIT" ? net : net.map((amount) => amount.negated());
    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      subtype: account.subtype,
      ...seriesOf(signed),
    };
  });

  // A row with nothing in any month is noise on a twelve-column table.
  const visible = all.filter(
    (row) => options.includeZeroRows || row.months.some((amount) => !amount.isZero()),
  );

  const sections: MonthlySection[] = (
    ["INCOME", "COST_OF_SALES", "EXPENSES", "OTHER_INCOME", "OTHER_EXPENSE"] as const
  ).map((key) => {
    const sectionRows = visible.filter((row) => SUBTYPE_SECTION[row.subtype] === key);
    return {
      key,
      label: SECTION_LABELS[key],
      rows: sectionRows,
      ...seriesOf(
        sectionRows.reduce<Money[]>(
          (totals, row) => totals.map((amount, index) => amount.plus(row.months[index])),
          zeros(months.length),
        ),
      ),
    };
  });

  const find = (key: PlSection["key"]): Series =>
    sections.find((section) => section.key === key) ?? seriesOf(zeros(months.length));

  const income = find("INCOME");
  const costOfSales = find("COST_OF_SALES");
  const grossProfit = combine(income, costOfSales, (a, b) => a.minus(b));
  const expenses = find("EXPENSES");
  const operatingIncome = combine(grossProfit, expenses, (a, b) => a.minus(b));
  const otherIncome = find("OTHER_INCOME");
  const otherExpense = find("OTHER_EXPENSE");
  const netIncome = combine(
    combine(operatingIncome, otherIncome, (a, b) => a.plus(b)),
    otherExpense,
    (a, b) => a.minus(b),
  );

  return {
    from: options.from,
    to: options.to,
    months,
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
