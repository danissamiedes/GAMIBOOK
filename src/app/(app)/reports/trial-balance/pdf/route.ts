import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { trialBalance } from "@/lib/ledger/reports";
import { brandingFor } from "@/lib/pdf/render";
import { renderReportPdf } from "@/lib/pdf/report";
import { formatMoney } from "@/lib/currency";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";

export async function GET(request: Request) {
  const scope = await sectionScope("REPORTS");
  const url = new URL(request.url);
  const asOf = parseAccountingDate(url.searchParams.get("asOf") ?? "") ?? today();
  const from = parseAccountingDate(url.searchParams.get("from") ?? "");

  const [company, report] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    trialBalance({ companyId: scope.companyId, asOf, from }),
  ]);

  const amount = (value: { isZero: () => boolean; toFixed: (n: number) => string }) =>
    value.isZero() ? "" : formatMoney(value.toFixed(2), company.baseCurrency);

  const bytes = await renderReportPdf(await brandingFor(scope.companyId), {
    title: "Trial Balance",
    subtitle: `${from ? `${formatAccountingDate(from)} to ` : "Up to "}${formatAccountingDate(asOf)} · ${company.baseCurrency}`,
    columns: [
      { label: "Code", width: 60 },
      { label: "Account" },
      { label: "Debit", width: 100, align: "right" },
      { label: "Credit", width: 100, align: "right" },
    ],
    rows: report.rows.map((row) => [row.code, row.name, amount(row.debit), amount(row.credit)]),
    totalRow: [
      "",
      "Total",
      formatMoney(report.totalDebit.toFixed(2), company.baseCurrency),
      formatMoney(report.totalCredit.toFixed(2), company.baseCurrency),
    ],
    note: report.balanced ? undefined : "OUT OF BALANCE — investigate before using this report.",
  });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="TrialBalance-${formatAccountingDate(asOf)}.pdf"`,
    },
  });
}
