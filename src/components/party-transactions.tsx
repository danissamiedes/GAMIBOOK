import Link from "next/link";
import { formatMoney } from "@/lib/currency";
import { formatAccountingDate } from "@/lib/dates";
import {
  PARTY_TRANSACTION_LIMIT,
  type PartyTotals,
  type PartyTransaction,
} from "@/lib/parties/transactions";
import { Alert, Button, Card, DataTable, EmptyState, Field, Input } from "@/components/ui";

/**
 * The two faces of a party's record (SPEC §6).
 *
 * Plain links rather than a client-side switch: a tab is a different question
 * about the same party, so it deserves its own address — one that can be
 * bookmarked, opened in a second tab, and come back to after a save.
 *
 * Transactions comes first and opens by default, because "what have we had
 * from them and what do we owe" is why somebody clicks a name; the fields
 * that describe them are what you go to when you need to change something.
 */
export function PartyTabs({
  base,
  active,
  transactionCount,
  label,
}: {
  base: string;
  active: "details" | "transactions";
  transactionCount: number;
  /** What this record is, for anyone listening rather than looking. */
  label: string;
}) {
  const tabs = [
    {
      key: "transactions" as const,
      label: `Transactions${transactionCount > 0 ? ` (${transactionCount})` : ""}`,
      href: base,
    },
    { key: "details" as const, label: "Details", href: `${base}?tab=details` },
  ];

  return (
    <div
      className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800"
      role="tablist"
      aria-label={`${label} record`}
    >
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          role="tab"
          aria-selected={active === tab.key}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            active === tab.key
              ? "border-brand-600 text-brand-700 dark:border-brand-500 dark:text-brand-400"
              : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}

/**
 * What this party has billed, and what has been paid.
 *
 * The amounts shown are each document's own — a bill in USD reads in USD —
 * with the totals in base currency, because adding currencies together is the
 * one thing a total must never quietly do.
 */
export function PartyTransactions({
  rows,
  totals,
  truncated,
  baseCurrency,
  emptyTitle,
  base,
  from,
  to,
  presets,
}: {
  rows: PartyTransaction[];
  totals: PartyTotals;
  truncated: boolean;
  baseCurrency: string;
  emptyTitle: string;
  /** This party's page, which the filter form and the export hang off. */
  base: string;
  /** The period being shown, as yyyy-mm-dd, or "" for all dates. */
  from: string;
  to: string;
  presets: { label: string; href: string }[];
}) {
  const filtered = Boolean(from || to);
  const exportQuery = new URLSearchParams();
  if (from) exportQuery.set("from", from);
  if (to) exportQuery.set("to", to);
  const exportHref = `${base}/export${exportQuery.size > 0 ? `?${exportQuery}` : ""}`;

  const period = (
    <Card className="mb-4">
      {/* A GET form, so the period is in the address: a filtered account is a
          link somebody can send to their accountant. */}
      <form className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="tab" value="transactions" />
        <Field label="From">
          <Input type="date" name="from" defaultValue={from} />
        </Field>
        <Field label="To">
          <Input type="date" name="to" defaultValue={to} />
        </Field>
        <Button type="submit">Apply</Button>
        {filtered ? (
          <Link href={base}>
            <Button type="button" variant="ghost">
              All dates
            </Button>
          </Link>
        ) : null}
        <a href={exportHref} className="ml-auto">
          <Button type="button" variant="secondary">
            Export to Excel
          </Button>
        </a>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">
        {presets.map((preset) => (
          <Link key={preset.label} href={preset.href}>
            <Button type="button" variant="ghost">
              {preset.label}
            </Button>
          </Link>
        ))}
      </div>
    </Card>
  );

  if (rows.length === 0) {
    return (
      <>
        {period}
        <EmptyState title={filtered ? "Nothing in that period" : emptyTitle}>
          {filtered
            ? "Bills, expenses, work orders and payments dated in the chosen period would appear here. Try a wider period, or clear it."
            : "Bills, direct expenses, work orders and payments recorded against this record will all appear here."}
        </EmptyState>
      </>
    );
  }

  return (
    <>
      {period}
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">Total billed</p>
          <p className="text-2xl font-bold tabular-nums">
            {formatMoney(totals.spend.toFixed(2), baseCurrency)}
          </p>
        </Card>
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">Paid</p>
          <p className="text-2xl font-bold tabular-nums">
            {formatMoney(totals.paid.toFixed(2), baseCurrency)}
          </p>
        </Card>
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">Still owed</p>
          <p
            className={`text-2xl font-bold tabular-nums ${
              totals.outstanding.greaterThan(0) ? "text-amber-700 dark:text-amber-500" : ""
            }`}
          >
            {formatMoney(totals.outstanding.toFixed(2), baseCurrency)}
          </p>
        </Card>
      </div>

      <Card>
        {truncated ? (
          <Alert tone="info">
            The most recent {PARTY_TRANSACTION_LIMIT} documents. The A/P aging and the general
            ledger hold the rest.
          </Alert>
        ) : null}

        <DataTable>
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
              <th className="py-2 pr-2">Date</th>
              <th className="py-2 pr-2">Type</th>
              <th className="py-2 pr-2">Reference</th>
              <th className="py-2 pr-2">Description</th>
              <th className="py-2 pr-2 text-right">Amount</th>
              <th className="py-2 pr-4 text-right">Still owed</th>
              <th className="py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.kind}-${row.id}`}
                className="border-b border-slate-100 align-top dark:border-slate-800/60"
              >
                <td className="py-2 pr-2 whitespace-nowrap text-sm">
                  {formatAccountingDate(row.date)}
                </td>
                <td className="py-2 pr-2 text-sm">
                  {/* The reference is the way in, so a document with none is
                      opened by its type instead: every row has exactly one
                      link, and it is never the date. */}
                  {row.reference ? (
                    row.label
                  ) : (
                    <Link href={row.href} className="underline decoration-dotted underline-offset-2">
                      {row.label}
                    </Link>
                  )}
                </td>
                <td className="py-2 pr-2 font-mono text-xs">
                  {row.reference ? (
                    <Link href={row.href} className="underline decoration-dotted underline-offset-2">
                      {row.reference}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="py-2 pr-2 text-sm">{row.description}</td>
                <td
                  className={`py-2 pr-2 text-right tabular-nums text-sm ${
                    row.kind === "PAYMENT" ? "text-emerald-700 dark:text-emerald-500" : ""
                  }`}
                >
                  {row.kind === "PAYMENT" ? "− " : ""}
                  {formatMoney(row.amount.toFixed(2), row.currency)}
                  {row.currency !== baseCurrency ? (
                    <span className="block text-xs text-slate-500">
                      {formatMoney(row.baseAmount.toFixed(2), baseCurrency)}
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-sm">
                  {row.outstanding && row.outstanding.greaterThan(0)
                    ? formatMoney(row.outstanding.toFixed(2), baseCurrency)
                    : "—"}
                </td>
                <td className="py-2 text-sm">{row.status}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Card>
    </>
  );
}
