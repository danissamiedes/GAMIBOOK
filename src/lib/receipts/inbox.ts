import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { hasInboxScopes } from "@/lib/email/gmail";
import { inboxFolderId, uploadToDrive } from "@/lib/google/drive";
import {
  listUnfiled,
  markFiled,
  readAttachment,
  readMessage,
} from "@/lib/google/gmail-read";

/**
 * Bills that arrive by email (SPEC §8.2 extension).
 *
 * A book publishes an address — `docs+kasagami@bookkeepingpoint.com` — and
 * whatever is forwarded there turns up in the receipt inbox, with its
 * attachments parked in the company's Drive. Nothing is posted: a row here
 * is a piece of paper somebody sent, and recording it as a bill or a direct
 * expense is a separate, deliberate act.
 *
 * Three things this is careful about.
 *
 * **One message is filed once.** The unique index on (company, provider id)
 * is the guarantee; the Gmail label is for the human reading the mailbox.
 * A label somebody removes by hand does not cause a duplicate.
 *
 * **A message with no usable attachment is still filed.** A bill pasted
 * into the body is a bill, and a row saying "nothing attached" is far
 * better than silence — the alternative is wondering why what you forwarded
 * never arrived.
 *
 * **One company's failure is its own.** The poll walks every book that has
 * an address set; a revoked token on one must not stop another's post.
 */

/** The biggest attachment worth moving. Beyond this it is not a receipt. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type PollResult = {
  companyId: string;
  filed: number;
  attachments: number;
  error?: string;
};

/** Books that take bills by email and can actually be read. */
export async function inboxEnabledCompanies() {
  const companies = await prisma.company.findMany({
    where: { inboxAddress: { not: null } },
    select: {
      id: true,
      name: true,
      inboxAddress: true,
      emailConnection: { select: { scope: true, provider: true, needsReconnectAt: true } },
    },
  });
  return companies.filter(
    (company) =>
      company.emailConnection?.provider === "GOOGLE" &&
      !company.emailConnection.needsReconnectAt &&
      hasInboxScopes(company.emailConnection.scope),
  );
}

/** Read one company's forwarding address and file what is waiting. */
export async function pollCompanyInbox(options: {
  companyId: string;
  companyName: string;
  address: string;
  max?: number;
}): Promise<PollResult> {
  const ids = await listUnfiled({
    companyId: options.companyId,
    address: options.address,
    max: options.max,
  });

  let filed = 0;
  let attachments = 0;

  for (const messageId of ids) {
    // Asked before the work: re-reading a message we already hold costs a
    // Gmail round trip and an upload, and the label may not have stuck.
    const already = await prisma.inboxMessage.findUnique({
      where: { companyId_providerId: { companyId: options.companyId, providerId: messageId } },
      select: { id: true },
    });
    if (already) {
      await markFiled(options.companyId, messageId);
      continue;
    }

    const message = await readMessage(options.companyId, messageId);

    const row = await prisma.inboxMessage.create({
      data: {
        companyId: options.companyId,
        providerId: message.id,
        receivedAt: message.receivedAt,
        fromAddress: message.from.slice(0, 320),
        subject: message.subject.slice(0, 500),
        deliveredTo: message.deliveredTo?.slice(0, 320) ?? null,
        snippet: message.snippet.slice(0, 500) || null,
      },
    });

    for (const attachment of message.attachments) {
      // Recorded either way: a row that says why a file could not be filed
      // is the only way anybody finds out it could not.
      if (attachment.size > MAX_ATTACHMENT_BYTES) {
        await prisma.inboxAttachment.create({
          data: {
            messageId: row.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            byteSize: attachment.size,
            uploadError: `Too large to file (${Math.round(attachment.size / 1_048_576)} MB).`,
          },
        });
        continue;
      }

      try {
        const bytes = await readAttachment(options.companyId, message.id, attachment.attachmentId);
        const folderId = await inboxFolderId(options.companyId, options.companyName);
        const uploaded = await uploadToDrive({
          companyId: options.companyId,
          folderId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          bytes,
        });
        await prisma.inboxAttachment.create({
          data: {
            messageId: row.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            byteSize: bytes.length,
            driveFileId: uploaded.fileId,
            viewUrl: uploaded.viewUrl,
          },
        });
        attachments += 1;
      } catch (error) {
        await prisma.inboxAttachment.create({
          data: {
            messageId: row.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            byteSize: attachment.size,
            uploadError: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          },
        });
      }
    }

    await markFiled(options.companyId, message.id);
    filed += 1;
  }

  if (filed > 0) {
    await writeAudit({
      companyId: options.companyId,
      action: "inbox.filed",
      entityType: "InboxMessage",
      summary: `${filed} forwarded to ${options.address}, ${attachments} file${
        attachments === 1 ? "" : "s"
      } to Drive`,
    });
  }

  return { companyId: options.companyId, filed, attachments };
}

/** The scheduled pass over every book that takes bills by email. */
export async function runInboxPoll(): Promise<PollResult[]> {
  const companies = await inboxEnabledCompanies();
  const results: PollResult[] = [];

  for (const company of companies) {
    try {
      results.push(
        await pollCompanyInbox({
          companyId: company.id,
          companyName: company.name,
          address: company.inboxAddress!,
        }),
      );
    } catch (error) {
      // One book's revoked token is not another's problem.
      console.error("[inbox] poll failed", company.id, error);
      results.push({
        companyId: company.id,
        filed: 0,
        attachments: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/** Take a message out of the queue without recording anything. */
export async function dismissInboxMessage(options: {
  companyId: string;
  messageId: string;
  reason?: string | null;
  userId?: string | null;
}) {
  const message = await prisma.inboxMessage.findFirst({
    where: { id: options.messageId, companyId: options.companyId },
  });
  if (!message) throw new PostingError("That message is not in this company");
  if (message.status === "RECORDED") {
    throw new PostingError("This one has been recorded already — void the expense instead.");
  }

  const updated = await prisma.inboxMessage.update({
    where: { id: message.id },
    data: {
      status: "DISMISSED",
      dismissedAt: new Date(),
      dismissedReason: options.reason?.trim() || null,
    },
  });

  await writeAudit({
    companyId: options.companyId,
    userId: options.userId,
    action: "inbox.dismissed",
    entityType: "InboxMessage",
    entityId: message.id,
    summary: message.subject,
  });
  return updated;
}

/** Put a dismissed one back in the queue. */
export async function restoreInboxMessage(companyId: string, messageId: string) {
  const message = await prisma.inboxMessage.findFirst({
    where: { id: messageId, companyId, status: "DISMISSED" },
  });
  if (!message) throw new PostingError("That message is not dismissed in this company");
  return prisma.inboxMessage.update({
    where: { id: message.id },
    data: { status: "WAITING", dismissedAt: null, dismissedReason: null },
  });
}

/**
 * Tie a message to the expense it became.
 *
 * Called after the expense is recorded rather than as part of recording it:
 * the inbox is a queue of paperwork, not part of the posting, and a failure
 * to tick a row off must never roll back a bill that is correctly in the
 * books.
 */
export async function markInboxRecorded(options: {
  companyId: string;
  messageId: string;
  expenseId: string;
  userId?: string | null;
}) {
  const message = await prisma.inboxMessage.findFirst({
    where: { id: options.messageId, companyId: options.companyId },
  });
  if (!message || message.status === "RECORDED") return null;

  const updated = await prisma.inboxMessage.update({
    where: { id: message.id },
    data: { status: "RECORDED", expenseId: options.expenseId },
  });

  await writeAudit({
    companyId: options.companyId,
    userId: options.userId,
    action: "inbox.recorded",
    entityType: "InboxMessage",
    entityId: message.id,
    summary: message.subject,
  });
  return updated;
}
