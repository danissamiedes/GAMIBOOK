import { createElement, type ReactElement } from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { prisma } from "@/lib/db";
import { storage, storageKeys } from "@/lib/storage";
import { formatMoney } from "@/lib/currency";
import { formatAccountingDate } from "@/lib/dates";
import { money } from "@/lib/money";
import { DocumentPdf } from "./document";
import type { BrandingData, DocumentPdfData } from "./types";

/**
 * PDF generation (SPEC §11). Generated PDFs are a **cache**: every one of these
 * is regenerable from the document at any time, so losing the storage volume
 * loses no financial data.
 */

export function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "unnamed"
  );
}

export async function brandingFor(companyId: string): Promise<BrandingData> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });

  let logoDataUri: string | null = null;
  if (company.logoFileKey) {
    try {
      const bytes = await storage().get(company.logoFileKey);
      const extension = company.logoFileKey.split(".").pop()?.toLowerCase();
      const mime = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "image/png";
      logoDataUri = `data:${mime};base64,${bytes.toString("base64")}`;
    } catch {
      // A missing logo must never stop an invoice going out.
      logoDataUri = null;
    }
  }

  return {
    companyName: company.legalName ?? company.name,
    addressLines: [
      company.addressLine1,
      company.addressLine2,
      [company.city, company.region, company.postalCode].filter(Boolean).join(", ") || null,
      company.country,
    ].filter((line): line is string => Boolean(line)),
    email: company.email,
    phone: company.phone,
    taxNumber: company.taxNumber,
    footerText: company.footerText,
    logoDataUri,
  };
}

async function render(branding: BrandingData, data: DocumentPdfData): Promise<Buffer> {
  // react-pdf types renderToBuffer as taking a <Document> element directly,
  // though it renders any tree that produces one. The cast is the whole cost
  // of keeping the template a normal component.
  const element = createElement(DocumentPdf, { branding, data }) as ReactElement<DocumentProps>;
  return renderToBuffer(element);
}

export type RenderedPdf = { filename: string; bytes: Buffer };

/** SPEC §11: `Invoice-{number}-{customer-slug}.pdf`. */
export async function renderInvoicePdf(companyId: string, invoiceId: string): Promise<RenderedPdf> {
  const invoice = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId, companyId },
    include: { customer: true, lines: { orderBy: { lineNumber: "asc" } } },
  });
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  const branding = await brandingFor(companyId);
  const currency = invoice.currency;

  const notes: string[] = [];
  if (currency !== company.baseCurrency) {
    notes.push(
      `Booked at ${invoice.fxRate.toFixed(4)} ${company.baseCurrency} per ${currency} — ${formatMoney(
        invoice.baseTotal.toFixed(2),
        company.baseCurrency,
      )}.`,
    );
  }

  const bytes = await render(branding, {
    title: "Invoice",
    number: invoice.invoiceNumber ?? "DRAFT",
    isDraft: invoice.status === "DRAFT",
    currency,
    partyLabel: "Bill to",
    partyName: invoice.customer.name,
    partyAddressLines: (invoice.customer.billingAddress ?? "").split("\n").filter(Boolean),
    fields: [
      { label: "Issue date", value: formatAccountingDate(invoice.issueDate) },
      { label: "Due date", value: formatAccountingDate(invoice.dueDate) },
      ...(invoice.terms ? [{ label: "Terms", value: invoice.terms }] : []),
      { label: "Currency", value: currency },
    ],
    lines: invoice.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity.toFixed(2),
      rate: line.rate.toFixed(2),
      amount: formatMoney(line.amount.toFixed(2), currency),
    })),
    totals: [
      { label: "Subtotal", value: formatMoney(invoice.subtotal.toFixed(2), currency) },
      ...(money(invoice.taxTotal).greaterThan(0)
        ? [{ label: "Tax", value: formatMoney(invoice.taxTotal.toFixed(2), currency) }]
        : []),
      { label: "Total", value: formatMoney(invoice.total.toFixed(2), currency), strong: true },
      ...(money(invoice.amountPaid).greaterThan(0)
        ? [
            { label: "Paid", value: formatMoney(invoice.amountPaid.toFixed(2), currency) },
            {
              label: "Balance due",
              value: formatMoney(invoice.balanceDue.toFixed(2), currency),
              strong: true,
            },
          ]
        : []),
    ],
    memo: invoice.memo,
    notes,
  });

  return {
    filename: `Invoice-${invoice.invoiceNumber ?? "DRAFT"}-${slug(invoice.customer.name)}.pdf`,
    bytes,
  };
}

/** SPEC §11: `WorkOrder-{number}-{consultant-slug}.pdf`, DRAFT-safe. */
export async function renderWorkOrderPdf(
  companyId: string,
  workOrderId: string,
): Promise<RenderedPdf> {
  const workOrder = await prisma.workOrder.findFirstOrThrow({
    where: { id: workOrderId, companyId },
    include: { vendor: true, lines: { orderBy: { lineNumber: "asc" } } },
  });
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  const branding = await brandingFor(companyId);
  const currency = workOrder.currency;

  const notes: string[] = [];
  if (workOrder.lines.some((line) => money(line.amount).isNegative())) {
    notes.push("Negative lines are deductions from this work order.");
  }
  if (currency !== company.baseCurrency) {
    notes.push(
      `Booked at ${workOrder.fxRate.toFixed(4)} ${company.baseCurrency} per ${currency}.`,
    );
  }

  const bytes = await render(branding, {
    title: "Work Order",
    number: workOrder.workOrderNumber ?? "DRAFT",
    isDraft: workOrder.status === "DRAFT",
    currency,
    partyLabel: "For",
    partyName: workOrder.vendor.name,
    partyAddressLines: workOrder.vendor.email ? [workOrder.vendor.email] : [],
    fields: [
      { label: "Date", value: formatAccountingDate(workOrder.issueDate) },
      { label: "Due date", value: formatAccountingDate(workOrder.dueDate) },
      { label: "Currency", value: currency },
    ],
    lines: workOrder.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity.toFixed(2),
      rate: line.rate.toFixed(2),
      amount: formatMoney(line.amount.toFixed(2), currency),
    })),
    totals: [
      { label: "Total", value: formatMoney(workOrder.total.toFixed(2), currency), strong: true },
      ...(money(workOrder.amountPaid).greaterThan(0)
        ? [
            { label: "Paid", value: formatMoney(workOrder.amountPaid.toFixed(2), currency) },
            {
              label: "Balance",
              value: formatMoney(workOrder.balanceDue.toFixed(2), currency),
              strong: true,
            },
          ]
        : []),
    ],
    memo: workOrder.memo,
    notes,
  });

  // A draft has no number, so the filename uses a short id — bulk attachments
  // must never collide (SPEC §11).
  const identifier = workOrder.workOrderNumber ?? `DRAFT-${workOrder.id.slice(-6)}`;
  return {
    filename: `WorkOrder-${identifier}-${slug(workOrder.vendor.name)}.pdf`,
    bytes,
  };
}

/** Payment receipt for a customer payment (SPEC §11). */
export async function renderReceiptPdf(companyId: string, paymentId: string): Promise<RenderedPdf> {
  const payment = await prisma.payment.findFirstOrThrow({
    where: { id: paymentId, companyId },
    include: {
      customer: true,
      applications: { include: { invoice: { select: { invoiceNumber: true, issueDate: true } } } },
    },
  });
  const branding = await brandingFor(companyId);
  const currency = payment.currency;

  const applied = payment.applications.reduce(
    (total, application) => total.plus(money(application.amountApplied)),
    money(0),
  );
  const unapplied = money(payment.amount).minus(applied);

  const bytes = await render(branding, {
    title: "Payment Receipt",
    number: payment.reference ?? payment.id.slice(-8).toUpperCase(),
    isDraft: false,
    currency,
    partyLabel: "Received from",
    partyName: payment.customer.name,
    partyAddressLines: [],
    fields: [
      { label: "Date", value: formatAccountingDate(payment.date) },
      { label: "Method", value: payment.method.replace(/_/g, " ").toLowerCase() },
      { label: "Currency", value: currency },
    ],
    lines: payment.applications.map((application) => ({
      description: `Invoice ${application.invoice.invoiceNumber ?? "draft"} of ${formatAccountingDate(
        application.invoice.issueDate,
      )}`,
      quantity: "",
      rate: "",
      amount: formatMoney(application.amountApplied.toFixed(2), currency),
    })),
    totals: [
      { label: "Amount received", value: formatMoney(payment.amount.toFixed(2), currency), strong: true },
      ...(unapplied.greaterThan(0)
        ? [{ label: "Unapplied (credit on account)", value: formatMoney(unapplied.toFixed(2), currency) }]
        : []),
    ],
    memo: payment.notes,
    notes: payment.reversedAt ? ["This payment has been reversed."] : [],
  });

  return {
    filename: `Receipt-${payment.reference ?? payment.id.slice(-8)}-${slug(payment.customer.name)}.pdf`,
    bytes,
  };
}

/**
 * Render and cache. The cache is a convenience: `force` regenerates, and a
 * missing object simply means rendering again.
 */
export async function cachedPdf(
  companyId: string,
  kind: "invoice" | "work-order" | "receipt",
  id: string,
  options: { force?: boolean } = {},
): Promise<RenderedPdf> {
  const key = storageKeys.documentPdf(companyId, kind, id);

  if (!options.force && (await storage().exists(key))) {
    const bytes = await storage().get(key);
    const filename = await filenameFor(companyId, kind, id);
    return { filename, bytes };
  }

  const rendered =
    kind === "invoice"
      ? await renderInvoicePdf(companyId, id)
      : kind === "work-order"
        ? await renderWorkOrderPdf(companyId, id)
        : await renderReceiptPdf(companyId, id);

  await storage().put(key, rendered.bytes, "application/pdf");
  return rendered;
}

async function filenameFor(companyId: string, kind: string, id: string): Promise<string> {
  if (kind === "invoice") {
    const invoice = await prisma.invoice.findFirstOrThrow({
      where: { id, companyId },
      include: { customer: { select: { name: true } } },
    });
    return `Invoice-${invoice.invoiceNumber ?? "DRAFT"}-${slug(invoice.customer.name)}.pdf`;
  }
  if (kind === "work-order") {
    const workOrder = await prisma.workOrder.findFirstOrThrow({
      where: { id, companyId },
      include: { vendor: { select: { name: true } } },
    });
    const identifier = workOrder.workOrderNumber ?? `DRAFT-${workOrder.id.slice(-6)}`;
    return `WorkOrder-${identifier}-${slug(workOrder.vendor.name)}.pdf`;
  }
  const payment = await prisma.payment.findFirstOrThrow({
    where: { id, companyId },
    include: { customer: { select: { name: true } } },
  });
  return `Receipt-${payment.reference ?? payment.id.slice(-8)}-${slug(payment.customer.name)}.pdf`;
}

/** Invalidate the cached PDF when a document changes. */
export async function invalidatePdf(companyId: string, kind: string, id: string) {
  await storage().delete(storageKeys.documentPdf(companyId, kind, id));
}
