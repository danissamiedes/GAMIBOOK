import type { EmailTemplateKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/currency";
import { formatAccountingDate } from "@/lib/dates";
import { money, sum, type Money } from "@/lib/money";

/**
 * The two documents that get emailed to a party in bulk (SPEC §10.1).
 *
 * A work order and a purchase order are sent the same way — a PDF each, one
 * message per party or one per document, the same batch machinery, the same
 * "who could not be emailed and why". Only four things differ: which table
 * they live in, what the number is called, which template is used and what
 * the placeholders are called. Those four things are this file, so the
 * sending engine does not have to know which kind it is carrying.
 */

export type SendableKind = "WORK_ORDER" | "PURCHASE_ORDER";

/** What the engine needs from a document, whichever kind it is. */
export type SendableDocument = {
  id: string;
  vendorId: string;
  /** The number, or "DRAFT" for one that has not been given one yet. */
  label: string;
  total: Money;
  currency: string;
  /** Due date for a work order, wanted-by date for a purchase order. */
  byDate: Date | null;
  isDraft: boolean;
  vendor: { id: string; name: string; email: string | null; ccEmails: string[]; sendEmails: boolean };
};

type Descriptor = {
  template: EmailTemplateKind;
  /** The key `cachedPdf` renders under. */
  pdfKind: "work-order" | "purchase-order";
  /** What an EmailLog calls it. */
  relatedType: "WorkOrder" | "PurchaseOrder";
  /** For messages people read: "work order", "consultant". */
  noun: string;
  partyNoun: string;
  /** Where the list of documents lives, for links on the batch screen. */
  listPath: string;
  fetch(companyId: string, ids: string[]): Promise<SendableDocument[]>;
  /** How many of these were emailed after a moment — the double-send guard. */
  emailedSince(companyId: string, ids: string[], since: Date): Promise<number>;
  /** The placeholders this kind's template may use. */
  values(documents: SendableDocument[], partyName: string, companyName: string): Record<string, string>;
};

const VENDOR_SELECT = {
  id: true,
  name: true,
  email: true,
  ccEmails: true,
  sendEmails: true,
} as const;

export const SENDABLE: Record<SendableKind, Descriptor> = {
  WORK_ORDER: {
    template: "WORK_ORDER",
    pdfKind: "work-order",
    relatedType: "WorkOrder",
    noun: "work order",
    partyNoun: "consultant",
    listPath: "/work-orders",
    async fetch(companyId, ids) {
      const rows = await prisma.workOrder.findMany({
        where: { id: { in: ids }, companyId },
        include: { vendor: { select: VENDOR_SELECT } },
        orderBy: [{ vendor: { name: "asc" } }, { issueDate: "asc" }],
      });
      return rows.map((row) => ({
        id: row.id,
        vendorId: row.vendorId,
        label: row.workOrderNumber ?? "DRAFT",
        total: money(row.total),
        currency: row.currency,
        byDate: row.dueDate,
        isDraft: row.status === "DRAFT",
        vendor: row.vendor,
      }));
    },
    emailedSince(companyId, ids, since) {
      return prisma.workOrder.count({
        where: { companyId, id: { in: ids }, lastEmailedAt: { gt: since } },
      });
    },
    values(documents, partyName, companyName) {
      const labels = documents.map((document) => document.label).join(", ");
      return {
        consultant_name: partyName,
        work_order_number: labels,
        work_order_count: String(documents.length),
        work_order_list: labels,
        total: formatMoney(
          sum(documents.map((document) => document.total)).toFixed(2),
          documents[0]?.currency ?? "",
        ),
        due_date: documents[0]?.byDate ? formatAccountingDate(documents[0].byDate!) : "",
        company_name: companyName,
      };
    },
  },

  PURCHASE_ORDER: {
    template: "PURCHASE_ORDER",
    pdfKind: "purchase-order",
    relatedType: "PurchaseOrder",
    noun: "purchase order",
    partyNoun: "vendor",
    listPath: "/purchase-orders",
    async fetch(companyId, ids) {
      const rows = await prisma.purchaseOrder.findMany({
        where: { id: { in: ids }, companyId },
        include: { vendor: { select: VENDOR_SELECT } },
        orderBy: [{ vendor: { name: "asc" } }, { orderDate: "asc" }],
      });
      return rows.map((row) => ({
        id: row.id,
        vendorId: row.vendorId,
        label: row.orderNumber ?? "DRAFT",
        total: money(row.total),
        currency: row.currency,
        byDate: row.expectedDate,
        isDraft: row.status === "DRAFT",
        vendor: row.vendor,
      }));
    },
    emailedSince(companyId, ids, since) {
      return prisma.purchaseOrder.count({
        where: { companyId, id: { in: ids }, lastEmailedAt: { gt: since } },
      });
    },
    values(documents, partyName, companyName) {
      const labels = documents.map((document) => document.label).join(", ");
      return {
        vendor_name: partyName,
        purchase_order_number: labels,
        purchase_order_count: String(documents.length),
        purchase_order_list: labels,
        total: formatMoney(
          sum(documents.map((document) => document.total)).toFixed(2),
          documents[0]?.currency ?? "",
        ),
        expected_date: documents[0]?.byDate ? formatAccountingDate(documents[0].byDate!) : "",
        company_name: companyName,
      };
    },
  },
};
