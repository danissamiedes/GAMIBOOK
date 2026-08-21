import { prisma } from "@/lib/db";
import { money, type Money } from "@/lib/money";
import { toBase } from "@/lib/ledger/fx";

/**
 * Sales by customer (SPEC §12.8). Part of the Sales section rather than
 * Reports, because it is the report the sales side lives in.
 *
 * Invoiced and paid are both measured from invoices dated in the period, in
 * base currency at each invoice's own rate — the rate it sits in the ledger at.
 */

export type SalesByCustomerRow = {
  customerId: string;
  customerName: string;
  currency: string;
  invoiceCount: number;
  invoiced: Money;
  paid: Money;
  outstanding: Money;
};

export async function salesByCustomer(options: {
  companyId: string;
  from: Date;
  to: Date;
}) {
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId: options.companyId,
      issueDate: { gte: options.from, lte: options.to },
      // A void invoice was never a sale.
      status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID"] },
    },
    include: { customer: { select: { id: true, name: true, defaultCurrency: true } } },
  });

  const rows = new Map<string, SalesByCustomerRow>();

  for (const invoice of invoices) {
    let row = rows.get(invoice.customerId);
    if (!row) {
      row = {
        customerId: invoice.customerId,
        customerName: invoice.customer.name,
        currency: invoice.customer.defaultCurrency,
        invoiceCount: 0,
        invoiced: money(0),
        paid: money(0),
        outstanding: money(0),
      };
      rows.set(invoice.customerId, row);
    }

    const invoiced = toBase(invoice.total, invoice.fxRate);
    const paid = toBase(invoice.amountPaid, invoice.fxRate);

    row.invoiceCount += 1;
    row.invoiced = row.invoiced.plus(invoiced);
    row.paid = row.paid.plus(paid);
    row.outstanding = row.outstanding.plus(invoiced.minus(paid));
  }

  const sorted = [...rows.values()].sort((a, b) =>
    b.invoiced.comparedTo(a.invoiced) || a.customerName.localeCompare(b.customerName),
  );

  return {
    from: options.from,
    to: options.to,
    rows: sorted,
    totals: {
      invoiceCount: sorted.reduce((total, row) => total + row.invoiceCount, 0),
      invoiced: sorted.reduce<Money>((total, row) => total.plus(row.invoiced), money(0)),
      paid: sorted.reduce<Money>((total, row) => total.plus(row.paid), money(0)),
      outstanding: sorted.reduce<Money>((total, row) => total.plus(row.outstanding), money(0)),
    },
  };
}
