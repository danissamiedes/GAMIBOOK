import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { salesByCustomer } from "@/lib/reports/sales-by-customer";
import { csvResponse } from "@/lib/reports/csv";
import { fiscalYearStart, formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";

export async function GET(request: Request) {
  const scope = await sectionScope("SALES");
  const url = new URL(request.url);

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const to = parseAccountingDate(url.searchParams.get("to") ?? "") ?? today();
  const from =
    parseAccountingDate(url.searchParams.get("from") ?? "") ??
    fiscalYearStart(to, company.fiscalYearStartMonth);

  const report = await salesByCustomer({ companyId: scope.companyId, from, to });

  const rows: unknown[][] = [
    [company.name],
    ["Sales by customer"],
    [`${formatAccountingDate(from)} to ${formatAccountingDate(to)}`],
    [`Amounts in ${company.baseCurrency}`],
    [],
    ["Customer", "Invoiced in", "Invoices", "Invoiced", "Paid", "Outstanding"],
    ...report.rows.map((row) => [
      row.customerName,
      row.currency,
      row.invoiceCount,
      row.invoiced.toFixed(2),
      row.paid.toFixed(2),
      row.outstanding.toFixed(2),
    ]),
    [
      "Total",
      "",
      report.totals.invoiceCount,
      report.totals.invoiced.toFixed(2),
      report.totals.paid.toFixed(2),
      report.totals.outstanding.toFixed(2),
    ],
  ];

  return csvResponse(
    rows,
    `SalesByCustomer-${formatAccountingDate(from)}-to-${formatAccountingDate(to)}.csv`,
  );
}
