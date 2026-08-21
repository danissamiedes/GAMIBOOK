import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { money, type Money } from "@/lib/money";
import { balancesByAccount } from "./balances";
import { arAging } from "@/lib/invoices/aging";
import { apAging } from "@/lib/payables/aging";
import type { CompanyScope } from "@/lib/company-scope";
import { minutesBetween } from "@/lib/time/zone";

/**
 * The dashboard (SPEC §12). Every tile is a section, not a decoration: a
 * bookkeeper holding only VENDORS must not learn the month's income from the
 * landing page, so each tile is computed only when its section is held and is
 * `null` otherwise. The page renders what it is given — the decision lives
 * here, next to the query, rather than in JSX.
 *
 * Figures come from the same libraries the reports use, so a tile that
 * disagrees with its report is a bug in one shared place instead of two.
 */

export type CashTile = {
  accounts: { id: string; code: string; name: string; amount: Money }[];
  total: Money;
};

export type TrendMonth = {
  /** yyyy-mm, for React keys and tests. */
  key: string;
  label: string;
  income: Money;
  expenses: Money;
  net: Money;
};

export type ReceivablesTile = {
  total: Money;
  overdue: Money;
  openCount: number;
  oldestDaysOverdue: number;
};

export type PayablesTile = {
  total: Money;
  overdue: Money;
  openCount: number;
  /** Only the kinds this user may see; a VENDORS-only user gets the regular side. */
  kinds: ("CONSULTANT" | "REGULAR")[];
};

export type ClockedInRow = {
  consultantId: string;
  name: string;
  since: Date;
  minutes: number;
};

export type BankTile = {
  unmatched: number;
  oldest: Date | null;
};

export type Dashboard = {
  asOf: Date;
  baseCurrency: string;
  cash: CashTile | null;
  trend: TrendMonth[] | null;
  receivables: ReceivablesTile | null;
  payables: PayablesTile | null;
  clockedIn: ClockedInRow[] | null;
  bank: BankTile | null;
  /** True when no section this user holds produces a tile. */
  empty: boolean;
};

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** The last `count` months ending with the one containing `asOf`, oldest first. */
export function trailingMonths(
  asOf: Date,
  count: number,
): { start: Date; end: Date; key: string; label: string }[] {
  const months = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const start = new Date(
      Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - offset, 1),
    );
    const end = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
    );
    months.push({
      start,
      end,
      key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
      label: `${MONTH_LABELS[start.getUTCMonth()]} ${String(start.getUTCFullYear()).slice(2)}`,
    });
  }
  return months;
}

/**
 * Income and expense per calendar month, in one pass.
 *
 * Six `balancesByAccount` calls would give the same answer and read more
 * consistently with the rest of the reports, but this runs on every page load
 * for every user — one grouped scan beats six sequential ones. The account
 * types are joined in SQL rather than filtered afterwards so the database does
 * not hand back every line in the period.
 */
async function incomeExpenseByMonth(companyId: string, from: Date, to: Date) {
  const rows = await prisma.$queryRaw<
    {
      month: Date;
      type: string;
      debit: Prisma.Decimal;
      credit: Prisma.Decimal;
    }[]
  >`
    SELECT date_trunc('month', e."date") AS month,
           a."type"::text AS type,
           SUM(l."debit") AS debit,
           SUM(l."credit") AS credit
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
    JOIN "Account" a ON a."id" = l."accountId"
    WHERE e."companyId" = ${companyId}
      AND e."date" >= ${from}::date
      AND e."date" <= ${to}::date
      AND a."type" IN ('INCOME', 'EXPENSE')
    GROUP BY 1, 2
  `;

  // Keyed yyyy-mm to match trailingMonths. date_trunc returns a timestamp at
  // UTC midnight on the first of the month, which is how accounting dates are
  // stored (SPEC §13), so no zone shifting is needed here.
  const byMonth = new Map<string, { income: Money; expenses: Money }>();
  for (const row of rows) {
    const month = new Date(row.month);
    const key = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
    const bucket = byMonth.get(key) ?? { income: money(0), expenses: money(0) };
    const net = money(row.debit).minus(money(row.credit));
    // Both are reported positive-when-normal: income is credit-normal, so its
    // net debit is negated; expenses are debit-normal and stand as they are.
    if (row.type === "INCOME")
      bucket.income = bucket.income.plus(net.negated());
    else bucket.expenses = bucket.expenses.plus(net);
    byMonth.set(key, bucket);
  }
  return byMonth;
}

export async function dashboard(options: {
  scope: CompanyScope;
  asOf: Date;
  baseCurrency: string;
  /** Now, for the clocked-in durations. Injected so tests are not wall-clock dependent. */
  now?: Date;
  months?: number;
}): Promise<Dashboard> {
  const { scope, asOf } = options;
  const now = options.now ?? new Date();
  const monthCount = options.months ?? 6;

  const seesFinancials = scope.hasSection("REPORTS");
  const seesSales = scope.hasSection("SALES");
  const payableKinds: PayablesTile["kinds"] = [
    ...(scope.hasSection("CONSULTANTS") ? (["CONSULTANT"] as const) : []),
    ...(scope.hasSection("VENDORS") ? (["REGULAR"] as const) : []),
  ];
  const seesConsultants = scope.hasSection("CONSULTANTS");
  const seesBanking = scope.hasSection("BANKING");

  const months = trailingMonths(asOf, monthCount);

  const [cashRows, trendRows, ar, apParts, openEntries, oldestUnmatched] =
    await Promise.all([
      seesFinancials
        ? balancesByAccount({
            companyId: scope.companyId,
            to: asOf,
            types: ["ASSET"],
          })
        : null,
      seesFinancials
        ? incomeExpenseByMonth(
            scope.companyId,
            months[0].start,
            months[months.length - 1].end,
          )
        : null,
      seesSales ? arAging({ companyId: scope.companyId, asOf }) : null,
      payableKinds.length > 0
        ? Promise.all(
            payableKinds.map((kind) =>
              apAging({ companyId: scope.companyId, asOf, kind }),
            ),
          )
        : null,
      seesConsultants
        ? prisma.timeEntry.findMany({
            where: { companyId: scope.companyId, clockOutAt: null },
            include: { consultant: { select: { id: true, name: true } } },
            orderBy: { clockInAt: "asc" },
          })
        : null,
      // The tile deferred in Phase 9 for want of the bank import (SPEC §12).
      seesBanking
        ? prisma.bankTransaction.findMany({
            where: { companyId: scope.companyId, status: "UNMATCHED" },
            orderBy: { date: "asc" },
            take: 1,
            select: { date: true },
          })
        : null,
    ]);

  const cash: CashTile | null = cashRows
    ? (() => {
        const cashAccounts = cashRows.filter(
          (row) =>
            row.subtype === "CASH" || row.subtype === "UNDEPOSITED_FUNDS",
        );
        const total = cashAccounts.reduce(
          (running, row) => running.plus(row.amount),
          money(0),
        );
        return {
          // An account sitting at zero is already in the total and tells the
          // reader nothing; Undeposited Funds is empty most of the time and
          // would otherwise head the list every day.
          accounts: cashAccounts
            .filter((row) => !row.amount.isZero())
            .map((row) => ({
              id: row.accountId,
              code: row.code,
              name: row.name,
              amount: row.amount,
            })),
          total,
        };
      })()
    : null;

  const trend: TrendMonth[] | null = trendRows
    ? months.map((month) => {
        const bucket = trendRows.get(month.key) ?? {
          income: money(0),
          expenses: money(0),
        };
        return {
          key: month.key,
          label: month.label,
          income: bucket.income,
          expenses: bucket.expenses,
          net: bucket.income.minus(bucket.expenses),
        };
      })
    : null;

  const receivables: ReceivablesTile | null = ar
    ? {
        total: ar.totals.total,
        // Overdue is everything that is not current — the buckets already
        // decided that, so it is not re-derived from due dates here.
        overdue: ar.totals.total.minus(ar.totals.current),
        openCount: ar.rows.reduce(
          (count, row) => count + row.invoices.length,
          0,
        ),
        oldestDaysOverdue: ar.rows.reduce(
          (oldest, row) =>
            row.invoices.reduce(
              (inner, invoice) => Math.max(inner, invoice.daysOverdue),
              oldest,
            ),
          0,
        ),
      }
    : null;

  const payables: PayablesTile | null = apParts
    ? {
        total: apParts.reduce(
          (total, part) => total.plus(part.totals.total),
          money(0),
        ),
        overdue: apParts.reduce(
          (total, part) =>
            total.plus(part.totals.total.minus(part.totals.current)),
          money(0),
        ),
        openCount: apParts.reduce(
          (count, part) =>
            count +
            part.rows.reduce((inner, row) => inner + row.documents.length, 0),
          0,
        ),
        kinds: payableKinds,
      }
    : null;

  const clockedIn: ClockedInRow[] | null = openEntries
    ? openEntries.map((entry) => ({
        consultantId: entry.consultant.id,
        name: entry.consultant.name,
        since: entry.clockInAt,
        minutes: minutesBetween(entry.clockInAt, now),
      }))
    : null;

  const bank: BankTile | null = oldestUnmatched
    ? {
        unmatched: await prisma.bankTransaction.count({
          where: { companyId: scope.companyId, status: "UNMATCHED" },
        }),
        oldest: oldestUnmatched[0]?.date ?? null,
      }
    : null;

  return {
    asOf,
    baseCurrency: options.baseCurrency,
    cash,
    trend,
    receivables,
    payables,
    clockedIn,
    bank,
    empty: !cash && !trend && !receivables && !payables && !clockedIn && !bank,
  };
}
