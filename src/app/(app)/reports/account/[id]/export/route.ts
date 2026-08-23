import { notFound } from "next/navigation";
import { sectionScope } from "@/lib/session-scope";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { parseAccountingDate, today } from "@/lib/dates";
import { normalBalance } from "@/lib/ledger/accounts";
import { accountDetail, sourceLabel } from "@/lib/reports/general-ledger";
import { accountFilename, buildAccountWorkbook } from "@/lib/exports/account-workbook";

/**
 * The account detail screen as a spreadsheet (SPEC §12.4).
 *
 * Scoped exactly like the page it comes from — the REPORTS section, and the
 * account looked up through `scope.where` so an id from another company is a
 * 404 rather than a download. An export is the easiest place to accidentally
 * widen access, because nobody watches the rows go by.
 *
 * It reads the same `from`/`to` params the page does and calls the same
 * `accountDetail`, so the file and the screen cannot disagree.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const scope = await sectionScope("REPORTS");
  const { id } = await params;
  const query = new URL(request.url).searchParams;

  const account = await prisma.account.findFirst({ where: { id, ...scope.where } });
  if (!account) notFound();

  const company = await prisma.company.findFirstOrThrow({
    where: { id: scope.companyId },
    select: { name: true, baseCurrency: true },
  });

  const to = parseAccountingDate(query.get("to") ?? "") ?? today();
  const from = parseAccountingDate(query.get("from") ?? "");

  const detail = await accountDetail({
    companyId: scope.companyId,
    accountId: account.id,
    from,
    to,
  });

  const bytes = await buildAccountWorkbook({
    companyName: company.name,
    baseCurrency: company.baseCurrency,
    account: {
      code: account.code,
      name: account.name,
      type: account.type,
      normalBalance: normalBalance(account.type),
    },
    from,
    to,
    opening: detail.opening.toFixed(2),
    closing: detail.closing.toFixed(2),
    rows: detail.rows.map((row) => ({
      date: row.date,
      entryNumber: row.entryNumber,
      source: sourceLabel(row.sourceType),
      description: row.description ?? row.memo ?? "",
      partyName: row.partyName,
      debit: row.debit.toFixed(2),
      credit: row.credit.toFixed(2),
      runningBalance: row.runningBalance.toFixed(2),
    })),
  });

  await writeAudit({
    companyId: scope.companyId,
    userId: scope.userId,
    action: "accountDetail.exported",
    entityType: "Account",
    entityId: account.id,
    summary: `${account.code} ${account.name} — ${detail.rows.length} line${
      detail.rows.length === 1 ? "" : "s"
    }`,
  });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${accountFilename(
        account,
        company.name,
        new Date(),
      )}"`,
      "cache-control": "private, no-store",
    },
  });
}
