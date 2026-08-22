import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { arAging, agingBucketLabels, bucketValues } from "@/lib/invoices/aging";
import { formatAccountingDate, isoDate, parseAccountingDate, today } from "@/lib/dates";

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export async function GET(request: Request) {
  const scope = await sectionScope("SALES");
  const url = new URL(request.url);
  const asOf = parseAccountingDate(url.searchParams.get("asOf") ?? "") ?? today();

  const [company, report] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    arAging({ companyId: scope.companyId, asOf }),
  ]);

  const rows = [
    [company.name],
    ["A/R Aging"],
    [`As at ${formatAccountingDate(asOf)}`],
    [`Amounts in ${company.baseCurrency}`],
    [],
    ["Customer", ...agingBucketLabels(), "Total"],
    ...report.rows.map((row) => [
      row.customerName,
      ...bucketValues(row).map((value) => value.toFixed(2)),
      row.total.toFixed(2),
    ]),
    [
      "Total",
      ...bucketValues(report.totals).map((value) => value.toFixed(2)),
      report.totals.total.toFixed(2),
    ],
    [],
    ["A/R control account", report.controlBalance.toFixed(2)],
    ["Ties to ledger", report.tiesToLedger ? "yes" : "NO — investigate"],
  ];

  return new Response(rows.map((row) => row.map((cell) => csvCell(String(cell))).join(",")).join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="AR-Aging-${isoDate(asOf)}.csv"`,
    },
  });
}
