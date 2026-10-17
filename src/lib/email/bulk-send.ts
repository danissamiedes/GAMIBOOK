import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { formatMoney } from "@/lib/currency";
import { money, sum } from "@/lib/money";
import { renderTemplate, templateFor } from "./templates";
import { sendEmail, stampEmailed, workOrderRecipients } from "./send";
import { SENDABLE, type SendableKind } from "./sendable";
import type { Attachment } from "./mime";

/**
 * Bulk send of work orders or purchase orders (SPEC §10.1).
 *
 * One engine, two documents. What differs between them — the table, the
 * number's name, the template, the placeholders — lives in `sendable.ts`, so
 * everything below is about sending rather than about which kind is being
 * sent.
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
/**
 * How long one pass may spend sending before it stops and leaves the rest
 * queued.
 *
 * A serverless function is killed at its `maxDuration` with no warning and no
 * chance to write anything down. A batch of eighteen at roughly seven seconds
 * each — render the PDF, upload it to Gmail, throttle — runs well past the 60s
 * the app segment declares, and the kill lands mid-loop: the messages already
 * sent are recorded, the rest stay QUEUED, the batch never finalises, and the
 * person sees a generic error page instead of the batch.
 *
 * So a pass stops itself first. 45s leaves room for the send in flight plus the
 * finalise write. What is left stays QUEUED and the batch stays resumable,
 * which is the state this design was already built for.
 */
const PASS_BUDGET_MS = 45_000;
/** Gmail rejects messages over 25 MB; leave room for encoding overhead. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type PlannedRecipient = {
  vendorId: string;
  /** The consultant or the vendor, depending on the kind being sent. */
  consultantName: string;
  documentIds: string[];
  documentLabels: string[];
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
  kind?: SendableKind;
  documentIds: string[];
  groupByConsultant: boolean;
}): Promise<BulkSendPlan> {
  const descriptor = SENDABLE[options.kind ?? "WORK_ORDER"];
  const documents = await descriptor.fetch(options.companyId, options.documentIds);

  if (documents.length === 0) throw new PostingError(`No ${descriptor.noun}s selected`);

  const groups = new Map<string, typeof documents>();
  for (const document of documents) {
    // Grouped: one message per party. Otherwise one per document.
    const key = options.groupByConsultant ? document.vendorId : document.id;
    groups.set(key, [...(groups.get(key) ?? []), document]);
  }

  const recipients: PlannedRecipient[] = [];
  for (const documents of groups.values()) {
    const vendor = documents[0].vendor;
    const resolved = workOrderRecipients(vendor);
    recipients.push({
      vendorId: vendor.id,
      consultantName: vendor.name,
      documentIds: documents.map((document) => document.id),
      documentLabels: documents.map((document) => document.label),
      to: resolved.to,
      cc: resolved.cc,
      totalLabel: formatMoney(
        sum(documents.map((document) => money(document.total))).toFixed(2),
        documents[0].currency,
      ),
      excludedReason: resolved.reason,
      includesDrafts: documents.some((document) => document.isDraft),
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
      kind: options.kind ?? "WORK_ORDER",
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
  kind: SendableKind;
  recipient: PlannedRecipient;
  withAttachments: boolean;
}) {
  const descriptor = SENDABLE[options.kind];
  const [company, template, documents] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: options.companyId } }),
    templateFor(options.companyId, descriptor.template),
    descriptor.fetch(options.companyId, options.recipient.documentIds),
  ]);

  // Labels come from the documents themselves, not from the caller: the send
  // path has no reason to know them, and a caller that passes none must not
  // silently produce "Work order  from …".
  const values = descriptor.values(documents, options.recipient.consultantName, company.name);

  const attachments: Attachment[] = [];
  if (options.withAttachments) {
    // Loaded here rather than at the top of the file: the renderer is heavy,
    // and a batch raised without attachments must not pay for it.
    const { cachedPdf } = await import("@/lib/pdf/render");
    for (const document of documents) {
      // Rendered at send time from the current document, never from a stale
      // cache (SPEC §10.1).
      const pdf = await cachedPdf(options.companyId, descriptor.pdfKind, document.id, {
        force: true,
      });
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
  kind?: SendableKind;
  documentIds: string[];
  groupByConsultant: boolean;
  userId?: string | null;
}) {
  const kind = options.kind ?? "WORK_ORDER";
  const descriptor = SENDABLE[kind];
  const plan = await planBulkSend({
    companyId: options.companyId,
    kind,
    documentIds: options.documentIds,
    groupByConsultant: options.groupByConsultant,
  });

  if (plan.emailCount === 0) {
    throw new PostingError(
      `None of the selected ${descriptor.noun}s can be emailed. Check the ${descriptor.partyNoun}s' email setup.`,
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
      kind,
      status: "QUEUED",
      groupByConsultant: options.groupByConsultant,
      totalCount: plan.emailCount,
      skippedCount: plan.excluded.length,
      createdByUserId: options.userId ?? null,
      items: {
        create: [
          ...plan.sendable.map((recipient) => ({
            vendorId: recipient.vendorId,
            documentIds: recipient.documentIds,
            toAddresses: recipient.to,
            ccAddresses: recipient.cc,
            status: "QUEUED" as const,
          })),
          // Excluded consultants are recorded, not dropped: the batch must be
          // able to show who did not get anything and why.
          ...plan.excluded.map((recipient) => ({
            vendorId: recipient.vendorId,
            documentIds: recipient.documentIds,
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
    action: kind === "PURCHASE_ORDER"
      ? "purchase_order.bulk_send_queued"
      : "work_order.bulk_send_queued",
    entityType: "EmailBatch",
    entityId: batch.id,
    summary: `${plan.emailCount} emails to ${plan.consultantCount} ${descriptor.partyNoun}s`,
  });

  return { batchId: batch.id, plan };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Work through a batch's queued items. Safe to call more than once: only
 * QUEUED items are picked up, so a success is never sent twice.
 */
export async function processBatch(
  companyId: string,
  batchId: string,
  options: { budgetMs?: number } = {},
) {
  const budgetMs = options.budgetMs ?? PASS_BUDGET_MS;
  const batch = await prisma.emailBatch.findFirst({ where: { id: batchId, companyId } });
  if (!batch) throw new PostingError("Batch not found in this company");
  // The batch says which document it carries; it was stored when it was
  // raised, so a batch queued before this existed is still a work order one.
  const kind: SendableKind = batch.kind === "PURCHASE_ORDER" ? "PURCHASE_ORDER" : "WORK_ORDER";
  const descriptor = SENDABLE[kind];

  await prisma.emailBatch.updateMany({
    where: { id: batchId, status: { in: ["QUEUED", "COMPLETED_WITH_FAILURES"] } },
    data: { status: "SENDING" },
  });

  const queued = await prisma.emailBatchItem.findMany({
    where: { emailBatchId: batchId, status: "QUEUED" },
    orderBy: { id: "asc" },
  });

  const startedAt = Date.now();
  for (const [index, item] of queued.entries()) {
    // Checked before the work, not after: stopping with a message half-uploaded
    // is the thing this is here to avoid.
    if (Date.now() - startedAt > budgetMs) break;

    const vendor = await prisma.vendor.findFirst({ where: { id: item.vendorId, companyId } });
    if (!vendor) {
      await prisma.emailBatchItem.update({
        where: { id: item.id },
        data: {
          status: "FAILED",
          reason: `${descriptor.partyNoun === "vendor" ? "Vendor" : "Consultant"} no longer exists`,
          attempts: item.attempts + 1,
        },
      });
      continue;
    }

    // Everything in this item has been emailed since the batch was raised, so
    // sending it now would be a second copy of mail that already went. This is
    // not hypothetical: a send that stopped half way left nine messages queued,
    // the same nine were re-sent by hand from a new batch, and the old queue
    // still believed it had work to do.
    const alreadySent = await descriptor.emailedSince(companyId, item.documentIds, batch.createdAt);
    if (alreadySent >= item.documentIds.length && item.documentIds.length > 0) {
      await prisma.emailBatchItem.update({
        where: { id: item.id },
        data: {
          status: "SKIPPED",
          reason: "Already emailed after this batch was queued — not sent again.",
          attempts: item.attempts + 1,
        },
      });
      continue;
    }

    try {
      const composed = await composeMessage({
        companyId,
        kind,
        recipient: {
          vendorId: vendor.id,
          consultantName: vendor.name,
          documentIds: item.documentIds,
          documentLabels: [],
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
            reason: `Attachments total ${(attachmentBytes / 1_048_576).toFixed(1)} MB, over the 20 MB limit. Send these ${descriptor.noun}s separately.`,
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
          relatedType: descriptor.relatedType,
          relatedId: item.documentIds[0],
          recipientName: vendor.name,
        },
      });

      if (result.status === "SENT") {
        // Only now is the document marked as sent.
        for (const documentId of item.documentIds) {
          await stampEmailed(descriptor.relatedType, documentId, companyId);
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

/**
 * Batches with messages still waiting to go out.
 *
 * Without this a batch that stopped early is unreachable: the only link to its
 * page is the redirect at the end of the send action, and that is exactly the
 * line a killed function never gets to. The queue survived; the way back to it
 * did not.
 */
export async function unfinishedBatches(companyId: string) {
  const batches = await prisma.emailBatch.findMany({
    where: {
      companyId,
      status: { in: ["QUEUED", "SENDING"] },
      items: { some: { status: "QUEUED" } },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  return Promise.all(
    batches.map(async (batch) => ({
      batch,
      remaining: await prisma.emailBatchItem.count({
        where: { emailBatchId: batch.id, status: "QUEUED" },
      }),
    })),
  );
}

/**
 * Abandon what a batch has not sent.
 *
 * Until now the only thing you could do with a stranded queue was send it, and
 * that is the wrong answer when the documents have already gone out another
 * way. Marks the remainder SKIPPED and closes the batch; nothing already sent
 * is touched.
 */
export async function discardRemaining(options: {
  companyId: string;
  batchId: string;
  userId?: string | null;
}) {
  const batch = await prisma.emailBatch.findFirst({
    where: { id: options.batchId, companyId: options.companyId },
  });
  if (!batch) throw new PostingError("Batch not found in this company");

  const dropped = await prisma.emailBatchItem.updateMany({
    where: { emailBatchId: batch.id, status: "QUEUED" },
    data: { status: "SKIPPED", reason: "Discarded — not sent." },
  });
  if (dropped.count === 0) throw new PostingError("Nothing in this batch is still waiting");

  await writeAudit({
    companyId: options.companyId,
    userId: options.userId,
    action: "work_order.bulk_send_discarded",
    entityType: "EmailBatch",
    entityId: batch.id,
    summary: `${dropped.count} queued message(s) discarded without sending`,
  });

  return finaliseBatch(options.companyId, batch.id);
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

  const kind: SendableKind = batch.kind === "PURCHASE_ORDER" ? "PURCHASE_ORDER" : "WORK_ORDER";
  const ids = batch.items.flatMap((item) => item.documentIds);
  const fetched = await SENDABLE[kind].fetch(companyId, ids);
  const documents = new Map(
    fetched.map((document) => [
      document.id,
      {
        id: document.id,
        workOrderNumber: document.label,
        total: document.total,
        currency: document.currency,
      },
    ]),
  );

  return {
    batch,
    kind,
    items: batch.items.map((item) => ({
      ...item,
      consultantName: names.get(item.vendorId) ?? "(removed)",
      documents: item.documentIds.map((id) => documents.get(id)).filter(Boolean),
    })),
  };
}
