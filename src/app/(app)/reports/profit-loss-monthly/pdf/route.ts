import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { profitAndLossByMonth } from "@/lib/reports/profit-loss-by-month";
import { brandingFor } from "@/lib/pdf/render";
import { renderReportPdf } from "@/lib/pdf/report";
import { fiscalYearStart, formatAccountingDate, isoDate, parseAccountingDate, today } from "@/lib/dates";

/**
 * The monthly P&L as a PDF (SPEC §12.1).
 *
 * Sideways, because the report is a column per month and a year of them
 * does not fit down an upright page. The figures are bare rather than
 * carrying "PHP" on every cell: thirteen columns of money only fit if they
 * are numbers, and the subtitle says the currency once for all of them —
 * which is how a columnar statement is set anyway.
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

  // Grouped so a negative reads as a negative rather than as a stray dash
  // somewhere in the number.
  const amount = (value: { toFixed: (places: number) => string }) => {
    const text = value.toFixed(2);
    const negative = text.startsWith("-");
    const grouped = (negative ? text.slice(1) : text).replace(
      /\B(?=(\d{3})+(?!\d))/g,
      ",",
    );
    return negative ? `(${grouped})` : grouped;
  };

  const series = (label: string, row: { months: { toFixed(p: number): string }[]; total: { toFixed(p: number): string } }) => [
    label,
    ...row.months.map(amount),
    amount(row.total),
  ];

  const rows: string[][] = [];
  const boldRows: number[] = [];
  const ruledRows: number[] = [];
  const blank = Array.from({ length: report.months.length + 1 }, () => "");

  for (const section of report.sections) {
    if (section.rows.length === 0) continue;
    boldRows.push(rows.length);
    rows.push([section.label.toUpperCase(), ...blank]);
    for (const row of section.rows) {
      rows.push(series(`   ${row.code} ${row.name}`, row));
    }
    boldRows.push(rows.length);
    rows.push(series(`Total ${section.label.toLowerCase()}`, section));
  }

  for (const [label, line] of [
    ["Gross profit", report.grossProfit],
    ["Operating income", report.operatingIncome],
  ] as const) {
    boldRows.push(rows.length);
    ruledRows.push(rows.length);
    rows.push(series(label, line));
  }

  const bytes = await renderReportPdf(await brandingFor(scope.companyId), {
    title: "Profit & Loss by month",
    subtitle: `${formatAccountingDate(from)} to ${formatAccountingDate(to)} · accrual basis · ${company.baseCurrency}`,
    landscape: true,
    columns: [
      // The only fixed column: the months share what is left equally, so
      // they line up however many of them there are.
      { label: "Account", width: 150 },
      ...report.months.map((month) => ({ label: month.label, align: "right" as const })),
      { label: "Total", align: "right" as const },
    ],
    rows,
    boldRows,
    ruledRows,
    totalRow: series("Net income", report.netIncome),
    note:
      report.months.some((month) => !month.whole)
        ? "A column covering part of a month says so in its heading; the columns still sum to the total."
        : undefined,
  });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="ProfitAndLossByMonth-${isoDate(from)}-to-${isoDate(to)}.pdf"`,
    },
  });
}
