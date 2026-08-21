import type { JournalSourceType } from "@prisma/client";
import { Prisma, type VendorKind } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Reading a document's state *as at a date*, rather than as it stands now.
 *
 * Aging is the report that needs this. Both aging reports used to read each
 * document's current `balanceDue`, so "A/P as at 31 July" showed what is open
 * today — a document settled in August looked settled in July, and a report
 * run for a closed period quietly disagreed with the ledger for that period.
 *
 * Two things decide whether a document was outstanding on a date, and both
 * turn on an *accounting* date rather than a wall-clock one:
 *
 *   - was it voided? `voidedAt` records when someone clicked, but the void
 *     posts a reversing entry carrying the date the books use.
 *   - had a payment landed? Same story: `reversedAt` is the click,
 *     `reversalEntryId` points at the entry with the accounting date.
 *
 * Taking the timestamps instead would misfile anything reversed in one period
 * for another, which is precisely the case a historical aging exists to show.
 */

/** True when a reversal had not yet posted as at `asOf`. */
export function liveAt(reversedOn: Date | undefined, asOf: Date): boolean {
  return reversedOn === undefined || reversedOn > asOf;
}

/**
 * For documents of one source type, the accounting date on which each was
 * reversed — a void, in practice. Keyed by document id.
 */
export async function voidDates(
  companyId: string,
  sourceType: JournalSourceType,
  documentIds: string[],
): Promise<Map<string, Date>> {
  if (documentIds.length === 0) return new Map();
  const entries = await prisma.journalEntry.findMany({
    where: {
      companyId,
      sourceType,
      sourceId: { in: documentIds },
      reversedByEntryId: { not: null },
    },
    select: { sourceId: true, reversedBy: { select: { date: true } } },
  });
  const dates = new Map<string, Date>();
  for (const entry of entries) {
    if (entry.sourceId && entry.reversedBy)
      dates.set(entry.sourceId, entry.reversedBy.date);
  }
  return dates;
}

/**
 * The accounting date each reversal posted, keyed by the *reversal entry id*
 * a payment record points at.
 */
export async function reversalDates(
  entryIds: (string | null)[],
): Promise<Map<string, Date>> {
  const ids = entryIds.filter((id): id is string => Boolean(id));
  if (ids.length === 0) return new Map();
  const entries = await prisma.journalEntry.findMany({
    where: { id: { in: ids } },
    select: { id: true, date: true },
  });
  return new Map(entries.map((entry) => [entry.id, entry.date]));
}

/**
 * Documents still open as at a date, resolved in SQL rather than by loading
 * every document ever issued.
 *
 * The readable version — fetch each document with its applications and add
 * them up in JavaScript — is correct and was what this started as. It also
 * took thirteen seconds on six years of invoices, because "still open then"
 * cannot be answered without considering every document, and hydrating ten
 * thousand of them with their payments is the whole cost. The database can
 * answer it and return only the handful that are actually open.
 *
 * The three date rules are the same ones stated above: a payment counts only
 * if it was dated on or before the date, a reversal only removes it if the
 * reversing entry was dated on or before the date, and a document voided later
 * was still owed then.
 */
export type OpenDocumentRow = {
  id: string;
  partyId: string;
  partyName: string;
  label: string;
  dueDate: Date;
  currency: string;
  fxRate: Prisma.Decimal;
  balanceDue: Prisma.Decimal;
};

export async function openInvoicesAsOf(
  companyId: string,
  asOf: Date,
): Promise<OpenDocumentRow[]> {
  return prisma.$queryRaw<OpenDocumentRow[]>`
    SELECT i."id",
           i."customerId"    AS "partyId",
           c."name"          AS "partyName",
           COALESCE(i."invoiceNumber", 'draft') AS "label",
           i."dueDate",
           i."currency",
           i."fxRate",
           i."total" - COALESCE(SUM(
             CASE WHEN pay."date" <= ${asOf}::date
                   AND (rev."date" IS NULL OR rev."date" > ${asOf}::date)
                  THEN pa."amountApplied" ELSE 0 END
           ), 0) AS "balanceDue"
    FROM "Invoice" i
    JOIN "Customer" c ON c."id" = i."customerId"
    LEFT JOIN "PaymentApplication" pa ON pa."invoiceId" = i."id"
    LEFT JOIN "Payment" pay ON pay."id" = pa."paymentId"
    LEFT JOIN "JournalEntry" rev ON rev."id" = pay."reversalEntryId"
    WHERE i."companyId" = ${companyId}
      AND i."status" <> 'DRAFT'
      AND i."issueDate" <= ${asOf}::date
      -- Voided on or before the date: gone. Voided later: still owed then.
      AND NOT EXISTS (
        SELECT 1 FROM "JournalEntry" e
        JOIN "JournalEntry" vr ON vr."id" = e."reversedByEntryId"
        WHERE e."companyId" = i."companyId"
          AND e."sourceType" = 'INVOICE'
          AND e."sourceId" = i."id"
          AND vr."date" <= ${asOf}::date
      )
    GROUP BY i."id", c."name"
    HAVING i."total" - COALESCE(SUM(
             CASE WHEN pay."date" <= ${asOf}::date
                   AND (rev."date" IS NULL OR rev."date" > ${asOf}::date)
                  THEN pa."amountApplied" ELSE 0 END
           ), 0) > 0
    ORDER BY i."dueDate" ASC
  `;
}

/** The same, for the payables side: work orders and vendor bills together. */
export async function openPayablesAsOf(
  companyId: string,
  asOf: Date,
  kind: VendorKind | null,
): Promise<
  (OpenDocumentRow & { type: "workOrder" | "bill"; partyKind: VendorKind })[]
> {
  const kindFilter = kind
    ? Prisma.sql`AND v."kind" = ${kind}::"VendorKind"`
    : Prisma.empty;

  return prisma.$queryRaw`
    SELECT w."id",
           'workOrder' AS "type",
           w."vendorId" AS "partyId",
           v."name"     AS "partyName",
           v."kind"     AS "partyKind",
           COALESCE(w."workOrderNumber", 'draft') AS "label",
           w."dueDate",
           w."currency",
           w."fxRate",
           w."total" - COALESCE(SUM(
             CASE WHEN bp."date" <= ${asOf}::date
                   AND (rev."date" IS NULL OR rev."date" > ${asOf}::date)
                  THEN a."amountApplied" ELSE 0 END
           ), 0) AS "balanceDue"
    FROM "WorkOrder" w
    JOIN "Vendor" v ON v."id" = w."vendorId"
    LEFT JOIN "BillPaymentApplication" a ON a."workOrderId" = w."id"
    LEFT JOIN "BillPayment" bp ON bp."id" = a."billPaymentId"
    LEFT JOIN "JournalEntry" rev ON rev."id" = bp."reversalEntryId"
    WHERE w."companyId" = ${companyId}
      AND w."status" <> 'DRAFT'
      AND w."approvedAt" <= ${asOf}::date
      ${kindFilter}
      AND NOT EXISTS (
        SELECT 1 FROM "JournalEntry" e
        JOIN "JournalEntry" vr ON vr."id" = e."reversedByEntryId"
        WHERE e."companyId" = w."companyId"
          AND e."sourceType" = 'WORK_ORDER'
          AND e."sourceId" = w."id"
          AND vr."date" <= ${asOf}::date
      )
    GROUP BY w."id", v."name", v."kind"
    HAVING w."total" - COALESCE(SUM(
             CASE WHEN bp."date" <= ${asOf}::date
                   AND (rev."date" IS NULL OR rev."date" > ${asOf}::date)
                  THEN a."amountApplied" ELSE 0 END
           ), 0) > 0

    UNION ALL

    SELECT x."id",
           'bill' AS "type",
           x."vendorId" AS "partyId",
           v."name"     AS "partyName",
           v."kind"     AS "partyKind",
           x."description" AS "label",
           COALESCE(x."dueDate", x."date") AS "dueDate",
           x."currency",
           x."fxRate",
           x."amount" - COALESCE(SUM(
             CASE WHEN bp."date" <= ${asOf}::date
                   AND (rev."date" IS NULL OR rev."date" > ${asOf}::date)
                  THEN a."amountApplied" ELSE 0 END
           ), 0) AS "balanceDue"
    FROM "Expense" x
    JOIN "Vendor" v ON v."id" = x."vendorId"
    LEFT JOIN "BillPaymentApplication" a ON a."expenseId" = x."id"
    LEFT JOIN "BillPayment" bp ON bp."id" = a."billPaymentId"
    LEFT JOIN "JournalEntry" rev ON rev."id" = bp."reversalEntryId"
    WHERE x."companyId" = ${companyId}
      AND x."kind" = 'BILL'
      AND x."date" <= ${asOf}::date
      ${kindFilter}
      AND NOT EXISTS (
        SELECT 1 FROM "JournalEntry" e
        JOIN "JournalEntry" vr ON vr."id" = e."reversedByEntryId"
        WHERE e."companyId" = x."companyId"
          AND e."sourceType" = 'EXPENSE'
          AND e."sourceId" = x."id"
          AND vr."date" <= ${asOf}::date
      )
    GROUP BY x."id", v."name", v."kind"
    HAVING x."amount" - COALESCE(SUM(
             CASE WHEN bp."date" <= ${asOf}::date
                   AND (rev."date" IS NULL OR rev."date" > ${asOf}::date)
                  THEN a."amountApplied" ELSE 0 END
           ), 0) > 0

    ORDER BY "dueDate" ASC
  `;
}
