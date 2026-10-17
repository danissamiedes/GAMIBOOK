import type { VendorKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { parseAccountingDate } from "@/lib/dates";
import type { CompanyScope } from "@/lib/company-scope";
import {
  buildPartyTransactionsWorkbook,
  partyTransactionsFilename,
} from "@/lib/exports/party-transactions-workbook";
import { partyTransactions } from "./transactions";

/**
 * The transactions tab as a file (SPEC §6).
 *
 * Shared by the vendor and consultant routes, but the scope is not: each
 * route passes its own, already checked against its own section, and the
 * vendor kind is checked again here. An export is the easiest place to widen
 * access by accident, because nobody watches the rows go by.
 */
export async function partyTransactionsExport(options: {
  scope: CompanyScope;
  vendorId: string;
  vendorKind: VendorKind;
  /** The request URL, for the period the screen was showing. */
  url: string;
}): Promise<Response> {
  const vendor = await prisma.vendor.findFirst({
    where: { id: options.vendorId, kind: options.vendorKind, ...options.scope.where },
    select: { id: true, name: true },
  });
  if (!vendor) return new Response("Not found", { status: 404 });

  const params = new URL(options.url).searchParams;
  const from = parseAccountingDate(params.get("from"));
  const to = parseAccountingDate(params.get("to"));

  const [company, transactions] = await Promise.all([
    prisma.company.findFirstOrThrow({
      where: { id: options.scope.companyId },
      select: { name: true, baseCurrency: true },
    }),
    partyTransactions({
      companyId: options.scope.companyId,
      vendorId: vendor.id,
      from,
      to,
    }),
  ]);

  const bytes = await buildPartyTransactionsWorkbook({
    companyName: company.name,
    baseCurrency: company.baseCurrency,
    party: {
      name: vendor.name,
      kind: options.vendorKind === "CONSULTANT" ? "Consultant" : "Vendor",
    },
    from,
    to,
    rows: transactions.rows,
    totals: transactions.totals,
  });

  await writeAudit({
    companyId: options.scope.companyId,
    userId: options.scope.userId,
    action: "party_transactions.exported",
    entityType: "Vendor",
    entityId: vendor.id,
    summary: `${transactions.rows.length} row${
      transactions.rows.length === 1 ? "" : "s"
    } for ${vendor.name}`,
  });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${partyTransactionsFilename(
        vendor.name,
        new Date(),
      )}"`,
      "cache-control": "private, no-store",
    },
  });
}
