import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { profitAndLoss } from "@/lib/reports/profit-loss";
import { brandingFor } from "@/lib/pdf/render";
import { renderReportPdf } from "@/lib/pdf/report";
import { formatMoney } from "@/lib/currency";
import { fiscalYearStart, formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";

export async function GET(request: Request) {
  const scope = await sectionScope("REPORTS");
  const url = new URL(request.url);

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const to = parseAccountingDate(url.searchParams.get("to") ?? "") ?? today();
  const from =
    parseAccountingDate(url.searchParams.get("from") ?? "") ??
    fiscalYearStart(to, company.fiscalYearStartMonth);

  const report = await profitAndLoss({ companyId: scope.companyId, from, to });
  const amount = (value: { toFixed: (n: number) => string }) =>
    formatMoney(value.toFixed(2), company.baseCurrency);

  const rows: string[][] = [];
  for (const section of report.sections) {
    if (section.rows.length === 0) continue;
    rows.push([section.label.toUpperCase(), "", ""]);
    for (const row of section.rows) rows.push([`   ${row.code}`, row.name, amount(row.amount)]);
    rows.push(["", `Total ${section.label.toLowerCase()}`, amount(section.total)]);
  }
  rows.push(["", "Gross profit", amount(report.grossProfit)]);

  const bytes = await renderReportPdf(await brandingFor(scope.companyId), {
    title: "Profit & Loss",
    subtitle: `${formatAccountingDate(from)} to ${formatAccountingDate(to)} · accrual basis · ${company.baseCurrency}`,
    columns: [
      { label: "Code", width: 60 },
      { label: "Account" },
      { label: "Amount", width: 110, align: "right" },
    ],
    rows,
    totalRow: ["", "Net income", amount(report.netIncome)],
  });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="ProfitAndLoss-${formatAccountingDate(from)}-to-${formatAccountingDate(to)}.pdf"`,
    },
  });
}
