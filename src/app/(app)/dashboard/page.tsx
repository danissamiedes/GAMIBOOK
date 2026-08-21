import Link from "next/link";
import { financialScope } from "@/lib/session-scope";
import { prisma } from "@/lib/db";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { formatMoney } from "@/lib/currency";
import { today } from "@/lib/dates";
import { dashboard, type TrendMonth } from "@/lib/reports/dashboard";
import { formatDateTimeInZone, formatDuration } from "@/lib/time/zone";
import type { Money } from "@/lib/money";

export const metadata = { title: "Dashboard — Ledger" };

/**
 * The landing page (SPEC §12). Tiles are section-gated in the data layer, so
 * this file renders whatever it is handed and never decides who may see what.
 *
 * The unmatched-bank-lines tile the spec lists is not here: it counts rows
 * from the CSV bank import (§8.5), which is deferred. A tile reading "0
 * unmatched" would be a lie about reconciled books rather than an absent
 * feature, so it waits for the import.
 */
export default async function DashboardPage() {
  const scope = await financialScope();
  const company = await prisma.company.findFirstOrThrow({
    where: { id: scope.companyId },
  });
  const asOf = today();

  const view = await dashboard({
    scope,
    asOf,
    baseCurrency: company.baseCurrency,
  });

  return (
    <>
      <PageHeader
        title={company.name}
        description={`As at ${asOf.toISOString().slice(0, 10)} · books in ${company.baseCurrency}`}
      />

      {view.empty ? (
        <EmptyState title="Nothing to show yet">
          Your account has no sections that carry figures. An owner can grant
          them under Settings → Users.
        </EmptyState>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {view.cash ? (
          <Card>
            <Tile label="Cash on hand" href="/reports/balance-sheet" />
            <Amount value={view.cash.total} currency={company.baseCurrency} />
            {view.cash.accounts.length > 0 ? (
              <ul className="mt-3 space-y-1 text-sm text-slate-600 dark:text-slate-400">
                {view.cash.accounts.map((account) => (
                  <li key={account.id} className="flex justify-between gap-3">
                    <span className="truncate">{account.name}</span>
                    <span className="tabular-nums">
                      {formatMoney(
                        account.amount.toFixed(2),
                        company.baseCurrency,
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              // Every cash account is at zero, or there are none yet — either
              // way the total above already says it.
              <p className="mt-3 text-sm text-slate-500">No cash on hand.</p>
            )}
          </Card>
        ) : null}

        {view.receivables ? (
          <Card>
            <Tile label="Owed to you" href="/reports/ar-aging" />
            <Amount
              value={view.receivables.total}
              currency={company.baseCurrency}
            />
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
              {view.receivables.openCount === 0
                ? "Nothing outstanding."
                : `${view.receivables.openCount} open ${
                    view.receivables.openCount === 1 ? "invoice" : "invoices"
                  }`}
            </p>
            {view.receivables.overdue.greaterThan(0) ? (
              <p className="mt-1 text-sm font-medium text-red-700 dark:text-red-300">
                {formatMoney(
                  view.receivables.overdue.toFixed(2),
                  company.baseCurrency,
                )}{" "}
                overdue · oldest {view.receivables.oldestDaysOverdue} days
              </p>
            ) : null}
          </Card>
        ) : null}

        {view.payables ? (
          <Card>
            <Tile label="You owe" href="/reports/ap-aging" />
            <Amount
              value={view.payables.total}
              currency={company.baseCurrency}
            />
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
              {view.payables.openCount === 0
                ? "Nothing outstanding."
                : `${view.payables.openCount} open ${
                    view.payables.openCount === 1 ? "document" : "documents"
                  }`}
              {/* Say which side of payables this figure covers, so a
                  VENDORS-only user does not read it as the whole picture. */}
              {view.payables.kinds.length === 1
                ? view.payables.kinds[0] === "CONSULTANT"
                  ? " · consultants only"
                  : " · regular vendors only"
                : null}
            </p>
            {view.payables.overdue.greaterThan(0) ? (
              <p className="mt-1 text-sm font-medium text-amber-700 dark:text-amber-300">
                {formatMoney(
                  view.payables.overdue.toFixed(2),
                  company.baseCurrency,
                )}{" "}
                past due
              </p>
            ) : null}
          </Card>
        ) : null}

        {view.clockedIn ? (
          <Card>
            <Tile label="Clocked in now" href="/timesheets" />
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {view.clockedIn.length}
            </p>
            {view.clockedIn.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                Nobody is on the clock.
              </p>
            ) : (
              <ul className="mt-3 space-y-1 text-sm text-slate-600 dark:text-slate-400">
                {view.clockedIn.map((row) => (
                  <li
                    key={row.consultantId}
                    className="flex justify-between gap-3"
                  >
                    <span
                      className="truncate"
                      title={formatDateTimeInZone(
                        row.since,
                        company.timeClockTimeZone,
                      )}
                    >
                      {row.name}
                    </span>
                    <span className="tabular-nums">
                      {formatDuration(row.minutes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}
      </div>

      {view.trend ? (
        <Card className="mt-4">
          <Tile
            label="Income and expenses, last 6 months"
            href="/reports/profit-loss"
          />
          <TrendChart months={view.trend} currency={company.baseCurrency} />
        </Card>
      ) : null}
    </>
  );
}

function Tile({ label, href }: { label: string; href: string }) {
  return (
    <Link
      href={href}
      className="text-xs uppercase tracking-wide text-slate-500 hover:text-slate-900 hover:underline dark:hover:text-slate-100"
    >
      {label}
    </Link>
  );
}

function Amount({ value, currency }: { value: Money; currency: string }) {
  return (
    <p className="mt-1 text-2xl font-semibold tabular-nums">
      {formatMoney(value.toFixed(2), currency)}
    </p>
  );
}

/**
 * A plain CSS bar chart. Six months of two series does not justify a charting
 * dependency, and bars built from divs keep working with JavaScript disabled
 * and inside the PDF-free server render.
 */
function TrendChart({
  months,
  currency,
}: {
  months: TrendMonth[];
  currency: string;
}) {
  const peak = months.reduce(
    (highest, month) => {
      const larger = month.income.greaterThan(month.expenses)
        ? month.income
        : month.expenses;
      return larger.greaterThan(highest) ? larger : highest;
    },
    months[0]?.income.mul(0) ?? null,
  );

  const height = (value: Money) => {
    if (!peak || peak.lessThanOrEqualTo(0)) return 0;
    return Math.round(Number(value.div(peak).toFixed(4)) * 100);
  };

  if (!peak || peak.lessThanOrEqualTo(0)) {
    return (
      <p className="mt-3 text-sm text-slate-500">
        No income or expenses posted in the last six months.
      </p>
    );
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <div className="flex min-w-[420px] items-end gap-4">
        {months.map((month) => (
          <div
            key={month.key}
            className="flex flex-1 flex-col items-center gap-2"
          >
            <div className="flex h-32 w-full items-end justify-center gap-1">
              <div
                className="w-1/3 rounded-t bg-emerald-500/80"
                style={{ height: `${height(month.income)}%` }}
                title={`Income ${formatMoney(month.income.toFixed(2), currency)}`}
              />
              <div
                className="w-1/3 rounded-t bg-slate-400/80 dark:bg-slate-500/80"
                style={{ height: `${height(month.expenses)}%` }}
                title={`Expenses ${formatMoney(month.expenses.toFixed(2), currency)}`}
              />
            </div>
            <span className="text-xs text-slate-500">{month.label}</span>
            <span
              className={`text-xs tabular-nums ${
                month.net.isNegative()
                  ? "text-red-600 dark:text-red-400"
                  : "text-slate-600 dark:text-slate-400"
              }`}
            >
              {month.net.toFixed(0)}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 flex flex-wrap gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500/80" />{" "}
          Income
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-slate-400/80" />{" "}
          Expenses
        </span>
        <span>Figure under each month is net, in {currency}.</span>
      </p>
    </div>
  );
}
