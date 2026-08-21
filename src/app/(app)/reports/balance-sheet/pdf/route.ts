import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { balanceSheet } from "@/lib/reports/balance-sheet";
import { brandingFor } from "@/lib/pdf/render";
import { renderReportPdf } from "@/lib/pdf/report";
import { formatMoney } from "@/lib/currency";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";

export async function GET(request: Request) {
  const scope = await sectionScope("REPORTS");
  const url = new URL(request.url);
  const asOf = parseAccountingDate(url.searchParams.get("asOf") ?? "") ?? today();

  const [company, report] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    balanceSheet({ companyId: scope.companyId, asOf }),
  ]);

  const amount = (value: { toFixed: (n: number) => string }) =>
    formatMoney(value.toFixed(2), company.baseCurrency);

  const rows: string[][] = [];
  const group = (label: string, g: { rows: { code: string; name: string; amount: { toFixed: (n: number) => string } }[]; total: { toFixed: (n: number) => string } }) => {
    if (g.rows.length === 0) return;
    rows.push([label.toUpperCase(), "", ""]);
    for (const row of g.rows) rows.push([`   ${row.code}`, row.name, amount(row.amount)]);
    rows.push(["", `Total ${label.toLowerCase()}`, amount(g.total)]);
  };

  group("Current assets", report.assets.current);
  group("Fixed assets", report.assets.fixed);
  rows.push(["", "TOTAL ASSETS", amount(report.assets.total)]);
  group("Current liabilities", report.liabilities.current);
  group("Long-term liabilities", report.liabilities.longTerm);
  rows.push(["", "Total liabilities", amount(report.liabilities.total)]);
  rows.push(["EQUITY", "", ""]);
  for (const row of report.equity.accounts) rows.push([`   ${row.code}`, row.name, amount(row.amount)]);
  rows.push(["", "Opening balance equity", amount(report.equity.openingBalanceEquity)]);
  rows.push(["", "Retained earnings", amount(report.equity.retainedEarnings)]);
  rows.push([
    "",
    `Net income since ${formatAccountingDate(report.fiscalYearStart)}`,
    amount(report.equity.netIncome),
  ]);
  rows.push(["", "Total equity", amount(report.equity.total)]);

  const bytes = await renderReportPdf(await brandingFor(scope.companyId), {
    title: "Balance Sheet",
    subtitle: `As at ${formatAccountingDate(asOf)} · ${company.baseCurrency}`,
    columns: [
      { label: "Code", width: 60 },
      { label: "Account" },
      { label: "Amount", width: 110, align: "right" },
    ],
    rows,
    totalRow: ["", "TOTAL LIABILITIES AND EQUITY", amount(report.liabilitiesAndEquity)],
    note: report.balanced
      ? "Assets equal liabilities and equity to the cent."
      : `OUT OF BALANCE by ${report.difference.toFixed(2)} — do not rely on this report.`,
  });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="BalanceSheet-${formatAccountingDate(asOf)}.pdf"`,
    },
  });
}
