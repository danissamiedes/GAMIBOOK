import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { profitAndLossByMonth } from "@/lib/reports/profit-loss-by-month";
import { csvResponse } from "@/lib/reports/csv";
import { fiscalYearStart, formatAccountingDate, isoDate, parseAccountingDate, today } from "@/lib/dates";

/**
 * The monthly P&L as a spreadsheet: the same columns the screen shows, in the
 * same order, so a total typed into a workbook next to it lines up.
 */
export async function GET(request: Request) {
  const scope = await sectionScope("REPORTS");
  const url = new URL(request.url);

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const to = parseAccountingDate(url.searchParams.get("to") ?? "") ?? today();
  const from =
    parseAccountingDate(url.searchParams.get("from") ?? "") ??
    fiscalYearStart(to, company.fiscalYearStartMonth);

  const report = await profitAndLossByMonth({ companyId: scope.companyId, from, to });

  const rows: unknown[][] = [
    [company.name],
    ["Profit & Loss by month (accrual basis)"],
    [`${formatAccountingDate(from)} to ${formatAccountingDate(to)}`],
    [`Amounts in ${company.baseCurrency}`],
    [],
    ["Section", "Code", "Account", ...report.months.map((month) => month.label), "Total"],
  ];

  const line = (
    section: string,
    code: string,
    name: string,
    series: { months: { toFixed(places: number): string }[]; total: { toFixed(places: number): string } },
  ) => [
    section,
    code,
    name,
    ...series.months.map((amount) => amount.toFixed(2)),
    series.total.toFixed(2),
  ];

  for (const section of report.sections) {
    for (const row of section.rows) {
      rows.push(line(section.label, row.code, row.name, row));
    }
    if (section.rows.length > 0) {
      rows.push(line(`Total ${section.label}`, "", "", section));
    }
  }

  rows.push([]);
  rows.push(line("Gross profit", "", "", report.grossProfit));
  rows.push(line("Operating income", "", "", report.operatingIncome));
  rows.push(line("Net income", "", "", report.netIncome));

  return csvResponse(rows, `ProfitAndLossByMonth-${isoDate(from)}-to-${isoDate(to)}.csv`);
}
