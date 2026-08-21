import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { cachedPdf } from "@/lib/pdf/render";
import { formatMoney } from "@/lib/currency";
import { formatAccountingDate } from "@/lib/dates";
import { money, sum } from "@/lib/money";
import { renderTemplate, templateFor } from "./templates";
import { sendEmail, stampEmailed, workOrderRecipients } from "./send";
import type { Attachment } from "./mime";

/**
 * Bulk work order send (SPEC §10.1).
 *
 * The shape of this file follows three requirements that are easy to get
 * wrong and expensive when you do:
 *
 *   - A consultant who cannot be emailed is **listed as excluded with the
 *     reason**, never silently dropped.
 *   - A partial failure does not abort the batch: each message succeeds or
 *     fails on its own, and "retry failed only" can never re-send a success.
 *   - `lastEmailedAt` is stamped only when a message actually goes out.
 */

export const MAX_BATCH_EMAILS = 200;
/** Gmail is not a bulk sender; a small gap keeps well inside its limits. */
const THROTTLE_MS = 400;
/** Gmail rejects messages over 25 MB; leave room for encoding overhead. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type PlannedRecipient = {
  vendorId: string;
  consultantName: string;
  workOrderIds: string[];
  workOrderLabels: string[];
  to: string[];
  cc: string[];
  totalLabel: string;
  /** Set when this consultant cannot be emailed at all. */
  excludedReason?: string;
  /** True when any document in this message has not been approved. */
  includesDrafts: boolean;
};

export type BulkSendPlan = {
  recipients: PlannedRecipient[];
  sendable: PlannedRecipient[];
  excluded: PlannedRecipient[];
  emailCount: number;
  consultantCount: number;
  recipientAddressCount: number;
  draftCount: number;
  subjectSample: string | null;
  bodySample: string | null;
};

/** What the confirmation screen shows before anything is sent. */
export async function planBulkSend(options: {
  companyId: string;
  workOrderIds: string[];
  groupByConsultant: boolean;
}): Promise<BulkSendPlan> {
  const workOrders = await prisma.workOrder.findMany({
    where: { id: { in: options.workOrderIds }, companyId: options.companyId },
    include: { vendor: true },
    orderBy: [{ vendor: { name: "asc" } }, { issueDate: "asc" }],
  });

  if (workOrders.length === 0) throw new PostingError("No work orders selected");

  const groups = new Map<string, typeof workOrders>();
  for (const workOrder of workOrders) {
    // Grouped: one message per consultant. Otherwise one per document.
    const key = options.groupByConsultant ? workOrder.vendorId : workOrder.id;
    groups.set(key, [...(groups.get(key) ?? []), workOrder]);
  }

  const recipients: PlannedRecipient[] = [];
  for (const documents of groups.values()) {
    const vendor = documents[0].vendor;
    const resolved = workOrderRecipients(vendor);
    recipients.push({
      vendorId: vendor.id,
      consultantName: vendor.name,
      workOrderIds: documents.map((document) => document.id),
      workOrderLabels: documents.map((document) => document.workOrderNumber ?? "DRAFT"),
      to: resolved.to,
      cc: resolved.cc,
      totalLabel: formatMoney(
        sum(documents.map((document) => money(document.total))).toFixed(2),
        documents[0].currency,
      ),
      excludedReason: resolved.reason,
      includesDrafts: documents.some((document) => document.status === "DRAFT"),
    });
  }

  const sendable = recipients.filter((recipient) => !recipient.excludedReason);
  const excluded = recipients.filter((recipient) => recipient.excludedReason);

  // One rendered example, so the user sees the actual words before sending.
  let subjectSample: string | null = null;
  let bodySample: string | null = null;
  if (sendable[0]) {
    const preview = await composeMessage({
      companyId: options.companyId,
      recipient: sendable[0],
      withAttachments: false,
    });
    subjectSample = preview.subject;
    bodySample = preview.body;
  }

  return {
    recipients,
    sendable,
    excluded,
    emailCount: sendable.length,
    consultantCount: new Set(sendable.map((recipient) => recipient.vendorId)).size,
    recipientAddressCount: new Set(sendable.flatMap((recipient) => [...recipient.to, ...recipient.cc]))
      .size,
    draftCount: sendable.filter((recipient) => recipient.includesDrafts).length,
    subjectSample,
    bodySample,
  };
}

/** Build one message, optionally rendering its attachments. */
async function composeMessage(options: {
  companyId: string;
  recipient: PlannedRecipient;
  withAttachments: boolean;
}) {
  const [company, template, workOrders] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: options.companyId } }),
    templateFor(options.companyId, "WORK_ORDER"),
    prisma.workOrder.findMany({
      where: { id: { in: options.recipient.workOrderIds }, companyId: options.companyId },
      orderBy: { issueDate: "asc" },
    }),
  ]);

  const total = sum(workOrders.map((workOrder) => money(workOrder.total)));
  // Labels come from the documents themselves, not from the caller: the send
  // path has no reason to know them, and a caller that passes none must not
  // silently produce "Work order  from …".
  const labels = workOrders.map((workOrder) => workOrder.workOrderNumber ?? "DRAFT").join(", ");
  const values: Record<string, string> = {
    consultant_name: options.recipient.consultantName,
    work_order_number: labels,
    work_order_count: String(workOrders.length),
    work_order_list: labels,
    total: formatMoney(total.toFixed(2), workOrders[0]?.currency ?? company.baseCurrency),
    due_date: workOrders[0] ? formatAccountingDate(workOrders[0].dueDate) : "",
    company_name: company.name,
  };

  const attachments: Attachment[] = [];
  if (options.withAttachments) {
    for (const workOrder of workOrders) {
      // Rendered at send time from the current document, never from a stale
      // cache (SPEC §10.1).
      const pdf = await cachedPdf(options.companyId, "work-order", workOrder.id, { force: true });
      attachments.push({ filename: pdf.filename, content: pdf.bytes });
    }
  }

  return {
    subject: renderTemplate(template.subject, values),
    body: renderTemplate(template.body, values),
    attachments,
  };
}

/** Create the batch. Sending happens separately, so the request returns fast. */
export async function queueBulkSend(options: {
  companyId: string;
  workOrderIds: string[];
  groupByConsultant: boolean;
  userId?: string | null;
}) {
  const plan = await planBulkSend({
    companyId: options.companyId,
    workOrderIds: options.workOrderIds,
    groupByConsultant: options.groupByConsultant,
  });

  if (plan.emailCount === 0) {
    throw new PostingError(
      "None of the selected work orders can be emailed. Check the consultants' email setup.",
    );
  }
  if (plan.emailCount > MAX_BATCH_EMAILS) {
    throw new PostingError(
      `That is ${plan.emailCount} emails. Send at most ${MAX_BATCH_EMAILS} at a time.`,
    );
  }

  const batch = await prisma.emailBatch.create({
    data: {
      companyId: options.companyId,
      kind: "WORK_ORDER",
      status: "QUEUED",
      groupByConsultant: options.groupByConsultant,
      totalCount: plan.emailCount,
      skippedCount: plan.excluded.length,
      createdByUserId: options.userId ?? null,
      items: {
        create: [
          ...plan.sendable.map((recipient) => ({
            vendorId: recipient.vendorId,
            workOrderIds: recipient.workOrderIds,
            toAddresses: recipient.to,
            ccAddresses: recipient.cc,
            status: "QUEUED" as const,
          })),
          // Excluded consultants are recorded, not dropped: the batch must be
          // able to show who did not get anything and why.
          ...plan.excluded.map((recipient) => ({
            vendorId: recipient.vendorId,
            workOrderIds: recipient.workOrderIds,
            toAddresses: [],
            ccAddresses: [],
            status: "SKIPPED" as const,
            reason: recipient.excludedReason,
          })),
        ],
      },
    },
  });

  await writeAudit({
    companyId: options.companyId,
    userId: options.userId,
    action: "work_order.bulk_send_queued",
    entityType: "EmailBatch",
    entityId: batch.id,
    summary: `${plan.emailCount} emails to ${plan.consultantCount} consultants`,
  });

  return { batchId: batch.id, plan };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Work through a batch's queued items. Safe to call more than once: only
 * QUEUED items are picked up, so a success is never sent twice.
 */
export async function processBatch(companyId: string, batchId: string) {
  const batch = await prisma.emailBatch.findFirst({ where: { id: batchId, companyId } });
  if (!batch) throw new PostingError("Batch not found in this company");

  await prisma.emailBatch.updateMany({
    where: { id: batchId, status: { in: ["QUEUED", "COMPLETED_WITH_FAILURES"] } },
    data: { status: "SENDING" },
  });

  const queued = await prisma.emailBatchItem.findMany({
    where: { emailBatchId: batchId, status: "QUEUED" },
    orderBy: { id: "asc" },
  });

  for (const [index, item] of queued.entries()) {
    const vendor = await prisma.vendor.findFirst({ where: { id: item.vendorId, companyId } });
    if (!vendor) {
      await prisma.emailBatchItem.update({
        where: { id: item.id },
        data: { status: "FAILED", reason: "Consultant no longer exists", attempts: item.attempts + 1 },
      });
      continue;
    }

    try {
      const composed = await composeMessage({
        companyId,
        recipient: {
          vendorId: vendor.id,
          consultantName: vendor.name,
          workOrderIds: item.workOrderIds,
          workOrderLabels: [],
          to: item.toAddresses,
          cc: item.ccAddresses,
          totalLabel: "",
          includesDrafts: false,
        },
        withAttachments: true,
      });

      const attachmentBytes = composed.attachments.reduce(
        (total, attachment) => total + attachment.content.length,
        0,
      );
      if (attachmentBytes > MAX_ATTACHMENT_BYTES) {
        await prisma.emailBatchItem.update({
          where: { id: item.id },
          data: {
            status: "FAILED",
            reason: `Attachments total ${(attachmentBytes / 1_048_576).toFixed(1)} MB, over the 20 MB limit. Send these work orders separately.`,
            attempts: item.attempts + 1,
          },
        });
        continue;
      }

      const result = await sendEmail({
        companyId,
        emailBatchId: batchId,
        email: {
          to: item.toAddresses,
          cc: item.ccAddresses,
          subject: composed.subject,
          body: composed.body,
          attachments: composed.attachments,
          relatedType: "WorkOrder",
          relatedId: item.workOrderIds[0],
        },
      });

      if (result.status === "SENT") {
        // Only now is the document marked as sent.
        for (const workOrderId of item.workOrderIds) {
          await stampEmailed("WorkOrder", workOrderId, companyId);
        }
        await prisma.emailBatchItem.update({
          where: { id: item.id },
          data: {
            status: "SENT",
            emailLogId: result.emailLogId,
            sentAt: new Date(),
            attempts: item.attempts + 1,
            reason: null,
          },
        });
      } else {
        await prisma.emailBatchItem.update({
          where: { id: item.id },
          data: {
            status: "FAILED",
            emailLogId: result.emailLogId,
            reason: result.error ?? "Unknown failure",
            attempts: item.attempts + 1,
          },
        });
      }
    } catch (error) {
      // One message failing must never abort the batch.
      await prisma.emailBatchItem.update({
        where: { id: item.id },
        data: {
          status: "FAILED",
          reason: error instanceof Error ? error.message.slice(0, 500) : "Unexpected error",
          attempts: item.attempts + 1,
        },
      });
    }

    if (index < queued.length - 1) await sleep(THROTTLE_MS);
  }

  return finaliseBatch(companyId, batchId);
}

async function finaliseBatch(companyId: string, batchId: string) {
  const items = await prisma.emailBatchItem.findMany({ where: { emailBatchId: batchId } });
  const sent = items.filter((item) => item.status === "SENT").length;
  const failed = items.filter((item) => item.status === "FAILED").length;
  const skipped = items.filter((item) => item.status === "SKIPPED").length;
  const stillQueued = items.some((item) => item.status === "QUEUED");

  return prisma.emailBatch.update({
    where: { id: batchId },
    data: {
      sentCount: sent,
      failedCount: failed,
      skippedCount: skipped,
      status: stillQueued ? "SENDING" : failed > 0 ? "COMPLETED_WITH_FAILURES" : "COMPLETED",
      completedAt: stillQueued ? null : new Date(),
    },
  });
}

/**
 * Re-queue only what failed. Successes keep their status, so nothing that has
 * already gone out can be sent a second time (SPEC §10.1).
 */
export async function retryFailed(options: {
  companyId: string;
  batchId: string;
  userId?: string | null;
}) {
  const batch = await prisma.emailBatch.findFirst({
    where: { id: options.batchId, companyId: options.companyId },
  });
  if (!batch) throw new PostingError("Batch not found in this company");

  const requeued = await prisma.emailBatchItem.updateMany({
    where: { emailBatchId: batch.id, status: "FAILED" },
    data: { status: "QUEUED", reason: null },
  });
  if (requeued.count === 0) throw new PostingError("Nothing in this batch failed");

  await writeAudit({
    companyId: options.companyId,
    userId: options.userId,
    action: "work_order.bulk_send_retried",
    entityType: "EmailBatch",
    entityId: batch.id,
    summary: `${requeued.count} retried`,
  });

  return processBatch(options.companyId, batch.id);
}

export async function batchWithItems(companyId: string, batchId: string) {
  const batch = await prisma.emailBatch.findFirst({
    where: { id: batchId, companyId },
    include: { items: { orderBy: { id: "asc" } } },
  });
  if (!batch) return null;

  const vendorIds = [...new Set(batch.items.map((item) => item.vendorId))];
  const vendors = await prisma.vendor.findMany({
    where: { id: { in: vendorIds } },
    select: { id: true, name: true },
  });
  const names = new Map(vendors.map((vendor) => [vendor.id, vendor.name]));

  const workOrderIds = batch.items.flatMap((item) => item.workOrderIds);
  const workOrders = await prisma.workOrder.findMany({
    where: { id: { in: workOrderIds } },
    select: { id: true, workOrderNumber: true, total: true, currency: true },
  });
  const documents = new Map(workOrders.map((workOrder) => [workOrder.id, workOrder]));

  return {
    batch,
    items: batch.items.map((item) => ({
      ...item,
      consultantName: names.get(item.vendorId) ?? "(removed)",
      documents: item.workOrderIds.map((id) => documents.get(id)).filter(Boolean),
    })),
  };
}
