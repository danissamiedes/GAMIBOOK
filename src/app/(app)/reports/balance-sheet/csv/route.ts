import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { balanceSheet } from "@/lib/reports/balance-sheet";
import { csvResponse } from "@/lib/reports/csv";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";

export async function GET(request: Request) {
  const scope = await sectionScope("REPORTS");
  const url = new URL(request.url);
  const asOf = parseAccountingDate(url.searchParams.get("asOf") ?? "") ?? today();

  const [company, report] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    balanceSheet({ companyId: scope.companyId, asOf }),
  ]);

  const rows: unknown[][] = [
    [company.name],
    ["Balance Sheet"],
    [`As at ${formatAccountingDate(asOf)}`],
    [`Amounts in ${company.baseCurrency}`],
    [],
    ["Section", "Code", "Account", "Amount"],
  ];

  const addGroup = (label: string, group: { rows: { code: string; name: string; amount: { toFixed: (n: number) => string } }[]; total: { toFixed: (n: number) => string } }) => {
    for (const row of group.rows) rows.push([label, row.code, row.name, row.amount.toFixed(2)]);
    rows.push([`Total ${label}`, "", "", group.total.toFixed(2)]);
  };

  addGroup("Current assets", report.assets.current);
  addGroup("Fixed assets", report.assets.fixed);
  rows.push(["Total assets", "", "", report.assets.total.toFixed(2)]);
  rows.push([]);
  addGroup("Current liabilities", report.liabilities.current);
  addGroup("Long-term liabilities", report.liabilities.longTerm);
  rows.push(["Total liabilities", "", "", report.liabilities.total.toFixed(2)]);
  rows.push([]);
  for (const row of report.equity.accounts) rows.push(["Equity", row.code, row.name, row.amount.toFixed(2)]);
  rows.push(["Equity", "", "Opening balance equity", report.equity.openingBalanceEquity.toFixed(2)]);
  rows.push(["Equity", "", "Retained earnings", report.equity.retainedEarnings.toFixed(2)]);
  rows.push(["Equity", "", "  of which posted to the account", report.equity.retainedEarningsPosted.toFixed(2)]);
  rows.push(["Equity", "", "  of which prior years' profit", report.equity.priorYearEarnings.toFixed(2)]);
  rows.push([
    "Equity",
    "",
    `Net income since ${formatAccountingDate(report.fiscalYearStart)}`,
    report.equity.netIncome.toFixed(2),
  ]);
  rows.push(["Total equity", "", "", report.equity.total.toFixed(2)]);
  rows.push([]);
  rows.push(["Total liabilities and equity", "", "", report.liabilitiesAndEquity.toFixed(2)]);
  rows.push(["Balances", "", "", report.balanced ? "yes" : `NO — out by ${report.difference.toFixed(2)}`]);

  return csvResponse(rows, `BalanceSheet-${formatAccountingDate(asOf)}.csv`);
}
