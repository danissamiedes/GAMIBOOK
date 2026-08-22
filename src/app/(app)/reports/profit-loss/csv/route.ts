import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { profitAndLoss } from "@/lib/reports/profit-loss";
import { csvResponse } from "@/lib/reports/csv";
import { fiscalYearStart, formatAccountingDate, isoDate, parseAccountingDate, today } from "@/lib/dates";

export async function GET(request: Request) {
  const scope = await sectionScope("REPORTS");
  const url = new URL(request.url);

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const to = parseAccountingDate(url.searchParams.get("to") ?? "") ?? today();
  const from =
    parseAccountingDate(url.searchParams.get("from") ?? "") ??
    fiscalYearStart(to, company.fiscalYearStartMonth);

  const report = await profitAndLoss({ companyId: scope.companyId, from, to });

  const rows: unknown[][] = [
    [company.name],
    ["Profit & Loss (accrual basis)"],
    [`${formatAccountingDate(from)} to ${formatAccountingDate(to)}`],
    [`Amounts in ${company.baseCurrency}`],
    [],
    ["Section", "Code", "Account", "Amount"],
  ];

  for (const section of report.sections) {
    for (const row of section.rows) {
      rows.push([section.label, row.code, row.name, row.amount.toFixed(2)]);
    }
    if (section.rows.length > 0) {
      rows.push([`Total ${section.label}`, "", "", section.total.toFixed(2)]);
    }
  }

  rows.push([]);
  rows.push(["Gross profit", "", "", report.grossProfit.toFixed(2)]);
  rows.push(["Operating income", "", "", report.operatingIncome.toFixed(2)]);
  rows.push(["Net income", "", "", report.netIncome.toFixed(2)]);

  return csvResponse(rows, `ProfitAndLoss-${isoDate(from)}-to-${isoDate(to)}.csv`);
}
