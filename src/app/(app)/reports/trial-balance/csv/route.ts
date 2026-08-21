import { prisma } from "@/lib/db";
import { financialScope } from "@/lib/session-scope";
import { trialBalance } from "@/lib/ledger/reports";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";

/** CSV export (SPEC §12). Every report ships with one. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export async function GET(request: Request) {
  const scope = await financialScope();
  const url = new URL(request.url);

  const asOf = parseAccountingDate(url.searchParams.get("asOf") ?? "") ?? today();
  const from = parseAccountingDate(url.searchParams.get("from") ?? "");
  const includeZeroRows = url.searchParams.get("zero") === "1";

  const [company, report] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    trialBalance({ companyId: scope.companyId, asOf, from, includeZeroRows }),
  ]);

  const rows = [
    [company.name],
    ["Trial Balance"],
    [from ? `${formatAccountingDate(from)} to ${formatAccountingDate(asOf)}` : `As at ${formatAccountingDate(asOf)}`],
    [`Amounts in ${company.baseCurrency}`],
    [],
    ["Code", "Account", "Type", "Debit", "Credit"],
    ...report.rows.map((row) => [
      row.code,
      row.name,
      row.type,
      row.debit.isZero() ? "" : row.debit.toFixed(2),
      row.credit.isZero() ? "" : row.credit.toFixed(2),
    ]),
    ["", "Total", "", report.totalDebit.toFixed(2), report.totalCredit.toFixed(2)],
  ];

  const csv = rows.map((row) => row.map((cell) => csvCell(String(cell))).join(",")).join("\r\n");

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="TrialBalance-${formatAccountingDate(asOf)}.csv"`,
    },
  });
}
