import { prisma } from "@/lib/db";
import { money, sum, type Money } from "@/lib/money";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { accountBalance } from "@/lib/ledger/reports";
import { toBase } from "@/lib/ledger/fx";
import { openInvoicesAsOf } from "@/lib/reports/as-of";

/**
 * A/R aging (SPEC §12.5): per customer, current / 1–30 / 31–60 / 61–90 / 90+.
 *
 * Buckets need a due date, which the ledger does not carry, so the rows are
 * built from open invoices. The total is then checked against the A/R control
 * account balance from the general ledger — if the two disagree, the report
 * says so rather than quietly showing a figure nobody can tie out.
 */

export type AgingBuckets = {
  current: Money;
  days1to30: Money;
  days31to60: Money;
  days61to90: Money;
  days90plus: Money;
  total: Money;
};

export type AgingRow = AgingBuckets & {
  customerId: string;
  customerName: string;
  invoices: {
    id: string;
    invoiceNumber: string | null;
    dueDate: Date;
    currency: string;
    balanceDue: Money;
    baseBalance: Money;
    daysOverdue: number;
  }[];
};

export type AgingReport = {
  asOf: Date;
  rows: AgingRow[];
  totals: AgingBuckets;
  /** The A/R control account balance from the ledger. */
  controlBalance: Money;
  /** True when the aging total equals the control account, to the cent. */
  tiesToLedger: boolean;
};

function emptyBuckets(): AgingBuckets {
  return {
    current: money(0),
    days1to30: money(0),
    days31to60: money(0),
    days61to90: money(0),
    days90plus: money(0),
    total: money(0),
  };
}

function addToBucket(
  buckets: AgingBuckets,
  daysOverdue: number,
  amount: Money,
) {
  if (daysOverdue <= 0) buckets.current = buckets.current.plus(amount);
  else if (daysOverdue <= 30)
    buckets.days1to30 = buckets.days1to30.plus(amount);
  else if (daysOverdue <= 60)
    buckets.days31to60 = buckets.days31to60.plus(amount);
  else if (daysOverdue <= 90)
    buckets.days61to90 = buckets.days61to90.plus(amount);
  else buckets.days90plus = buckets.days90plus.plus(amount);
  buckets.total = buckets.total.plus(amount);
}

export async function arAging(options: {
  companyId: string;
  asOf: Date;
}): Promise<AgingReport> {
  // Only what was actually open on the date, resolved in the database. The
  // readable version — load every invoice with its payments and add them up
  // here — is what this was, and it took thirteen seconds on six years of
  // invoices because "open then" has to consider every invoice ever issued.
  const open = await openInvoicesAsOf(options.companyId, options.asOf);

  const byCustomer = new Map<string, AgingRow>();

  for (const invoice of open) {
    const balanceDue = money(invoice.balanceDue);

    // Report in base currency, like every other report (SPEC §5). The open
    // balance is converted at the invoice's own rate — the rate it sits in the
    // ledger at.
    const baseBalance = toBase(balanceDue, invoice.fxRate);
    const daysOverdue = Math.floor(
      (options.asOf.getTime() - invoice.dueDate.getTime()) / 86_400_000,
    );

    let row = byCustomer.get(invoice.partyId);
    if (!row) {
      row = {
        ...emptyBuckets(),
        customerId: invoice.partyId,
        customerName: invoice.partyName,
        invoices: [],
      };
      byCustomer.set(invoice.partyId, row);
    }

    row.invoices.push({
      id: invoice.id,
      invoiceNumber: invoice.label,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      balanceDue,
      baseBalance,
      daysOverdue,
    });
    addToBucket(row, daysOverdue, baseBalance);
  }

  const rows = [...byCustomer.values()].sort((a, b) =>
    a.customerName.localeCompare(b.customerName),
  );

  const totals = emptyBuckets();
  for (const row of rows) {
    totals.current = totals.current.plus(row.current);
    totals.days1to30 = totals.days1to30.plus(row.days1to30);
    totals.days31to60 = totals.days31to60.plus(row.days31to60);
    totals.days61to90 = totals.days61to90.plus(row.days61to90);
    totals.days90plus = totals.days90plus.plus(row.days90plus);
    totals.total = totals.total.plus(row.total);
  }

  const receivable = await prisma.account.findFirst({
    where: {
      companyId: options.companyId,
      systemKey: SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE,
    },
    select: { id: true },
  });

  const controlBalance = receivable
    ? await accountBalance({
        companyId: options.companyId,
        accountId: receivable.id,
        asOf: options.asOf,
      })
    : money(0);

  return {
    asOf: options.asOf,
    rows,
    totals,
    controlBalance,
    tiesToLedger: totals.total.equals(controlBalance),
  };
}

export function agingBucketLabels() {
  return ["Current", "1–30", "31–60", "61–90", "90+"] as const;
}

export function bucketValues(buckets: AgingBuckets): Money[] {
  return [
    buckets.current,
    buckets.days1to30,
    buckets.days31to60,
    buckets.days61to90,
    buckets.days90plus,
  ];
}

export { sum };
