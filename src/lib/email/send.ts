import type { EmailTemplateKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { cachedPdf } from "@/lib/pdf/render";
import { formatMoney } from "@/lib/currency";
import { formatAccountingDate } from "@/lib/dates";
import { buildMimeMessage, toGmailRaw, type Attachment } from "./mime";
import { EmailSendError, dryRun, sendViaGmail } from "./gmail";
import { renderTemplate, templateFor } from "./templates";

/**
 * The one path every email takes (SPEC §10). Whatever calls it — a document
 * screen now, the bulk send in Phase 8 — the log row is written first and
 * updated with what happened, so a send is never invisible.
 *
 * `EMAIL_DRY_RUN=true` short-circuits the network call and still writes the
 * log. Development machines must not send real mail to real consultants.
 */

export type SendResult = {
  emailLogId: string;
  status: "SENT" | "FAILED";
  gmailMessageId?: string;
  error?: string;
  dryRun: boolean;
};

export type PreparedEmail = {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  attachments: Attachment[];
  relatedType?: string;
  relatedId?: string;
};

const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sendEmail(options: {
  companyId: string;
  email: PreparedEmail;
  userId?: string | null;
  emailBatchId?: string | null;
}): Promise<SendResult> {
  const { email } = options;

  const log = await prisma.emailLog.create({
    data: {
      companyId: options.companyId,
      toAddresses: email.to,
      cc: email.cc,
      subject: email.subject,
      bodySnapshot: email.body,
      attachmentNames: email.attachments.map((attachment) => attachment.filename),
      relatedType: email.relatedType ?? null,
      relatedId: email.relatedId ?? null,
      emailBatchId: options.emailBatchId ?? null,
      status: "QUEUED",
      sentByUserId: options.userId ?? null,
    },
  });

  if (email.to.length === 0) {
    const updated = await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: "FAILED", error: "No recipient address", attemptCount: 1 },
    });
    return { emailLogId: updated.id, status: "FAILED", error: updated.error ?? undefined, dryRun: false };
  }

  if (dryRun()) {
    const updated = await prisma.emailLog.update({
      where: { id: log.id },
      data: {
        status: "SENT",
        gmailMessageId: "dry-run",
        sentAt: new Date(),
        attemptCount: 1,
      },
    });
    return { emailLogId: updated.id, status: "SENT", gmailMessageId: "dry-run", dryRun: true };
  }

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const connection = await prisma.emailConnection.findUnique({
        where: { companyId: options.companyId },
      });
      const raw = toGmailRaw(
        buildMimeMessage({
          from: connection?.emailAddress ?? "unknown",
          to: email.to,
          cc: email.cc,
          subject: email.subject,
          text: email.body,
          attachments: email.attachments,
        }),
      );

      const sent = await sendViaGmail({ companyId: options.companyId, raw });
      const updated = await prisma.emailLog.update({
        where: { id: log.id },
        data: {
          status: "SENT",
          gmailMessageId: sent.gmailMessageId,
          sentAt: new Date(),
          attemptCount: attempt,
          error: null,
        },
      });
      return {
        emailLogId: updated.id,
        status: "SENT",
        gmailMessageId: sent.gmailMessageId,
        dryRun: false,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const transient = error instanceof EmailSendError && error.transient;
      if (!transient || attempt === MAX_ATTEMPTS) break;
      // Backoff on 429 and 5xx only — a rejected address will not fix itself.
      await sleep(2 ** attempt * 250);
    }
  }

  const failed = await prisma.emailLog.update({
    where: { id: log.id },
    data: { status: "FAILED", error: lastError.slice(0, 1000), attemptCount: MAX_ATTEMPTS },
  });
  return { emailLogId: failed.id, status: "FAILED", error: failed.error ?? undefined, dryRun: false };
}

/** Build the email for a document, ready to preview or send. */
export async function prepareInvoiceEmail(options: {
  companyId: string;
  invoiceId: string;
  kind?: Extract<EmailTemplateKind, "INVOICE" | "INVOICE_REMINDER">;
}): Promise<PreparedEmail> {
  const invoice = await prisma.invoice.findFirstOrThrow({
    where: { id: options.invoiceId, companyId: options.companyId },
    include: { customer: true },
  });
  const company = await prisma.company.findUniqueOrThrow({ where: { id: options.companyId } });
  const template = await templateFor(options.companyId, options.kind ?? "INVOICE");
  const pdf = await cachedPdf(options.companyId, "invoice", invoice.id, { force: true });

  const values: Record<string, string> = {
    customer_name: invoice.customer.name,
    invoice_number: invoice.invoiceNumber ?? "(draft)",
    total: formatMoney(invoice.total.toFixed(2), invoice.currency),
    due_date: formatAccountingDate(invoice.dueDate),
    company_name: company.name,
    days_overdue: String(
      Math.max(0, Math.floor((Date.now() - invoice.dueDate.getTime()) / 86_400_000)),
    ),
  };

  return {
    to: invoice.customer.emails,
    cc: [],
    subject: renderTemplate(template.subject, values),
    body: renderTemplate(template.body, values),
    attachments: [{ filename: pdf.filename, content: pdf.bytes }],
    relatedType: "Invoice",
    relatedId: invoice.id,
  };
}

/**
 * Recipients come from the consultant's own setup (SPEC §6): their address
 * plus any cc, and nothing at all if they are marked not to be emailed. The
 * caller decides what to do about an empty list — the bulk send in Phase 8
 * lists them as excluded rather than skipping them silently.
 */
export function workOrderRecipients(consultant: {
  email: string | null;
  ccEmails: string[];
  sendEmails: boolean;
}): { to: string[]; cc: string[]; reason?: string } {
  if (!consultant.sendEmails) return { to: [], cc: [], reason: "Marked not to be emailed" };
  if (!consultant.email) return { to: [], cc: [], reason: "No email address on file" };
  return { to: [consultant.email], cc: consultant.ccEmails };
}

export async function prepareWorkOrderEmail(options: {
  companyId: string;
  workOrderId: string;
}): Promise<PreparedEmail & { excludedReason?: string }> {
  const workOrder = await prisma.workOrder.findFirstOrThrow({
    where: { id: options.workOrderId, companyId: options.companyId },
    include: { vendor: true },
  });
  const company = await prisma.company.findUniqueOrThrow({ where: { id: options.companyId } });
  const template = await templateFor(options.companyId, "WORK_ORDER");
  const pdf = await cachedPdf(options.companyId, "work-order", workOrder.id, { force: true });
  const recipients = workOrderRecipients(workOrder.vendor);

  const values: Record<string, string> = {
    consultant_name: workOrder.vendor.name,
    work_order_number: workOrder.workOrderNumber ?? "(draft)",
    total: formatMoney(workOrder.total.toFixed(2), workOrder.currency),
    due_date: formatAccountingDate(workOrder.dueDate),
    company_name: company.name,
    work_order_count: "1",
    work_order_list: workOrder.workOrderNumber ?? "(draft)",
  };

  return {
    to: recipients.to,
    cc: recipients.cc,
    subject: renderTemplate(template.subject, values),
    body: renderTemplate(template.body, values),
    attachments: [{ filename: pdf.filename, content: pdf.bytes }],
    relatedType: "WorkOrder",
    relatedId: workOrder.id,
    excludedReason: recipients.reason,
  };
}

export async function preparePaymentReceiptEmail(options: {
  companyId: string;
  paymentId: string;
}): Promise<PreparedEmail> {
  const payment = await prisma.payment.findFirstOrThrow({
    where: { id: options.paymentId, companyId: options.companyId },
    include: { customer: true },
  });
  const company = await prisma.company.findUniqueOrThrow({ where: { id: options.companyId } });
  const template = await templateFor(options.companyId, "PAYMENT_RECEIPT");
  const pdf = await cachedPdf(options.companyId, "receipt", payment.id, { force: true });

  const values: Record<string, string> = {
    customer_name: payment.customer.name,
    amount: formatMoney(payment.amount.toFixed(2), payment.currency),
    payment_date: formatAccountingDate(payment.date),
    company_name: company.name,
  };

  return {
    to: payment.customer.emails,
    cc: [],
    subject: renderTemplate(template.subject, values),
    body: renderTemplate(template.body, values),
    attachments: [{ filename: pdf.filename, content: pdf.bytes }],
    relatedType: "Payment",
    relatedId: payment.id,
  };
}

/** Stamp the document once its email has actually gone out (SPEC §10.1). */
export async function stampEmailed(
  relatedType: string,
  relatedId: string,
  companyId: string,
): Promise<void> {
  if (relatedType === "Invoice") {
    await prisma.invoice.updateMany({
      where: { id: relatedId, companyId },
      data: { lastEmailedAt: new Date() },
    });
  } else if (relatedType === "WorkOrder") {
    await prisma.workOrder.updateMany({
      where: { id: relatedId, companyId },
      data: { lastEmailedAt: new Date() },
    });
  }
}
