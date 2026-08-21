import { prisma } from "@/lib/db";
import { money, sum, type Money } from "@/lib/money";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { accountBalance } from "@/lib/ledger/reports";
import { toBase } from "@/lib/ledger/fx";
import { liveAt, reversalDates, voidDates } from "@/lib/reports/as-of";

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

function addToBucket(buckets: AgingBuckets, daysOverdue: number, amount: Money) {
  if (daysOverdue <= 0) buckets.current = buckets.current.plus(amount);
  else if (daysOverdue <= 30) buckets.days1to30 = buckets.days1to30.plus(amount);
  else if (daysOverdue <= 60) buckets.days31to60 = buckets.days31to60.plus(amount);
  else if (daysOverdue <= 90) buckets.days61to90 = buckets.days61to90.plus(amount);
  else buckets.days90plus = buckets.days90plus.plus(amount);
  buckets.total = buckets.total.plus(amount);
}

export async function arAging(options: { companyId: string; asOf: Date }): Promise<AgingReport> {
  // Everything issued by the date, whatever it has become since. A PAID
  // invoice was still owed before the payment landed, and a voided one was
  // still owed before the void — so status cannot be the filter if the report
  // is to mean anything for a past date.
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId: options.companyId,
      status: { not: "DRAFT" },
      issueDate: { lte: options.asOf },
    },
    include: {
      customer: { select: { id: true, name: true } },
      applications: { include: { payment: true } },
    },
    orderBy: [{ dueDate: "asc" }],
  });

  const [voided, reversed] = await Promise.all([
    voidDates(
      options.companyId,
      "INVOICE",
      invoices.map((invoice) => invoice.id),
    ),
    reversalDates(
      invoices.flatMap((invoice) =>
        invoice.applications.map((application) => application.payment.reversalEntryId),
      ),
    ),
  ]);

  const byCustomer = new Map<string, AgingRow>();

  for (const invoice of invoices) {
    if (!liveAt(voided.get(invoice.id), options.asOf)) continue;

    // What had actually been applied by the date: a payment dated later has
    // not happened yet, and one reversed later was still in force.
    const paid = invoice.applications.reduce((total, application) => {
      const payment = application.payment;
      if (payment.date > options.asOf) return total;
      const reversedOn = payment.reversalEntryId
        ? reversed.get(payment.reversalEntryId)
        : undefined;
      if (!liveAt(reversedOn, options.asOf)) return total;
      return total.plus(money(application.amountApplied));
    }, money(0));

    const balanceDue = money(invoice.total).minus(paid);
    if (balanceDue.lessThanOrEqualTo(0)) continue;

    // Report in base currency, like every other report (SPEC §5). The open
    // balance is converted at the invoice's own rate — the rate it sits in the
    // ledger at.
    const baseBalance = toBase(balanceDue, invoice.fxRate);

    const daysOverdue = Math.floor(
      (options.asOf.getTime() - invoice.dueDate.getTime()) / 86_400_000,
    );

    let row = byCustomer.get(invoice.customerId);
    if (!row) {
      row = {
        ...emptyBuckets(),
        customerId: invoice.customerId,
        customerName: invoice.customer.name,
        invoices: [],
      };
      byCustomer.set(invoice.customerId, row);
    }

    row.invoices.push({
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      balanceDue,
      baseBalance,
      daysOverdue,
    });
    addToBucket(row, daysOverdue, baseBalance);
  }

  const rows = [...byCustomer.values()].sort((a, b) => a.customerName.localeCompare(b.customerName));

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
    where: { companyId: options.companyId, systemKey: SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE },
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
