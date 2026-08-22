import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ConfigurationError, PostingError } from "@/lib/errors";
import { money, toCents } from "@/lib/money";
import { accountingDate } from "@/lib/ledger/post";
import { isSupportedCurrency } from "@/lib/currency";
import { storage, storageKeys, withStorage } from "@/lib/storage";
import { writeAudit } from "@/lib/audit";
import { recordExpense } from "@/lib/payables/expenses";
import { safeExternalUrl } from "@/lib/links";
import { readReceipt } from "./extract";

/**
 * The receipt inbox (SPEC §8.2 extension).
 *
 * A photo arrives, is read, and waits. Approving it is what creates the
 * expense and posts it — the queue itself touches no account, which is the
 * whole reason it is a separate table rather than a draft expense.
 */

export const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

export async function uploadReceipt(input: {
  companyId: string;
  userId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}) {
  if (input.bytes.byteLength === 0) throw new PostingError("That file is empty");
  if (input.bytes.byteLength > MAX_RECEIPT_BYTES) {
    throw new PostingError(
      `That image is ${(input.bytes.byteLength / 1024 / 1024).toFixed(1)} MB. The limit is 8 MB — most phones can be told to send a smaller one.`,
    );
  }
  if (!input.mimeType.startsWith("image/")) {
    throw new PostingError("Receipts are images. Upload a photo, not a document.");
  }

  const receipt = await prisma.receiptUpload.create({
    data: {
      companyId: input.companyId,
      // A placeholder until the id exists to name the key with; replaced below.
      fileKey: "",
      filename: input.filename.slice(0, 200),
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      uploadedByUserId: input.userId,
    },
  });

  const fileKey = storageKeys.receiptInbox(input.companyId, receipt.id, input.filename);
  await withStorage("upload", () => storage().put(fileKey, input.bytes, input.mimeType));

  return prisma.receiptUpload.update({ where: { id: receipt.id }, data: { fileKey } });
}

/**
 * Read a pending receipt and record what came back.
 *
 * A failure is stored on the row rather than thrown away: the photo is still
 * in the queue, still approvable by hand, and the reason it could not be read
 * is on the screen next to it.
 */
export async function extractReceipt(companyId: string, receiptId: string) {
  const receipt = await prisma.receiptUpload.findFirst({
    where: { id: receiptId, companyId },
  });
  if (!receipt) throw new PostingError("Receipt not found in this company");
  if (receipt.status === "APPROVED") {
    throw new PostingError("This receipt has already been entered");
  }

  const bytes = await receiptBytes(receipt);

  try {
    const reading = await readReceipt({ bytes, mimeType: receipt.mimeType });
    const total = reading.total ? money(reading.total) : null;

    return await prisma.receiptUpload.update({
      where: { id: receipt.id },
      data: {
        status: "READY",
        readDate: reading.date ? accountingDate(new Date(`${reading.date}T00:00:00Z`)) : null,
        readAmount: total && total.greaterThan(0) ? toCents(total) : null,
        readCurrency:
          reading.currency && isSupportedCurrency(reading.currency.toUpperCase())
            ? reading.currency.toUpperCase()
            : null,
        readVendorName: reading.vendorName?.slice(0, 200) ?? null,
        readDescription: reading.description?.slice(0, 200) ?? null,
        readConfidence: reading.confidence,
        readError: reading.isReceipt ? null : "This does not look like a receipt.",
        readAt: new Date(),
      },
    });
  } catch (thrown) {
    // A configuration problem is the operator's and should not be written onto
    // every row as though the photo were at fault.
    if (thrown instanceof ConfigurationError) throw thrown;
    return prisma.receiptUpload.update({
      where: { id: receipt.id },
      data: {
        status: "READY",
        readError: thrown instanceof Error ? thrown.message.slice(0, 300) : "Could not read this image",
        readAt: new Date(),
      },
    });
  }
}

/**
 * The image itself.
 *
 * A thin wrapper so the read path and the view route fetch it the same way,
 * and so a storage failure is labelled once rather than at each call site.
 */
export async function receiptBytes(receipt: { fileKey: string }): Promise<Buffer> {
  return withStorage("download", () => storage().get(receipt.fileKey));
}

/**
 * Approve a receipt into a real expense. This is the only step that posts.
 *
 * The figures come from the form, not from the reading: what someone saw and
 * accepted on screen is what gets booked. The reading only decided what the
 * fields were pre-filled with.
 */
export async function approveReceipt(input: {
  companyId: string;
  receiptId: string;
  kind: "DIRECT" | "BILL";
  date: Date;
  amount: Prisma.Decimal.Value;
  currency: string;
  fxRate?: Prisma.Decimal.Value;
  description: string;
  expenseAccountId: string;
  paymentAccountId?: string | null;
  vendorId?: string | null;
  dueDate?: Date | null;
  reference?: string | null;
  /** Where the file can be seen, if it lives somewhere else too. */
  fileUrl?: string | null;
  userId: string;
  role?: Role | null;
}) {
  const receipt = await prisma.receiptUpload.findFirst({
    where: { id: input.receiptId, companyId: input.companyId },
  });
  if (!receipt) throw new PostingError("Receipt not found in this company");
  if (receipt.status === "APPROVED") {
    throw new PostingError("This receipt has already been entered");
  }

  const { expense } = await recordExpense({
    companyId: input.companyId,
    kind: input.kind,
    vendorId: input.vendorId ?? null,
    date: input.date,
    currency: input.currency,
    fxRate: input.fxRate,
    amount: input.amount,
    expenseAccountId: input.expenseAccountId,
    paymentAccountId: input.paymentAccountId,
    dueDate: input.dueDate,
    description: input.description,
    reference: input.reference,
    // The photo becomes the expense's receipt, so the document and its
    // evidence stay together without a second copy. A typed-in link is kept
    // alongside it rather than instead of it — they answer different
    // questions, and one is not a substitute for the other.
    receiptFileKey: receipt.fileKey,
    receiptUrl: safeExternalUrl(input.fileUrl),
    userId: input.userId,
    role: input.role,
  });

  const approved = await prisma.receiptUpload.update({
    where: { id: receipt.id },
    data: { status: "APPROVED", expenseId: expense.id },
  });

  await writeAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: "receipt.approved",
    entityType: "ReceiptUpload",
    entityId: receipt.id,
    summary: `${money(input.amount).toFixed(2)} ${input.currency} — ${input.description}`,
    data: { expenseId: expense.id, kind: input.kind },
  });

  return { receipt: approved, expense };
}

/** Out of the queue, still on file. Nothing is deleted. */
export async function dismissReceipt(input: {
  companyId: string;
  receiptId: string;
  reason?: string | null;
  userId: string;
}) {
  const receipt = await prisma.receiptUpload.findFirst({
    where: { id: input.receiptId, companyId: input.companyId },
  });
  if (!receipt) throw new PostingError("Receipt not found in this company");
  if (receipt.status === "APPROVED") {
    throw new PostingError(
      "This receipt is already an expense. Edit or void the expense instead.",
    );
  }

  const dismissed = await prisma.receiptUpload.update({
    where: { id: receipt.id },
    data: {
      status: "DISMISSED",
      dismissedAt: new Date(),
      dismissedReason: input.reason?.slice(0, 200) ?? null,
    },
  });

  await writeAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: "receipt.dismissed",
    entityType: "ReceiptUpload",
    entityId: receipt.id,
    summary: input.reason ?? null,
  });

  return dismissed;
}

/** Back into the queue after a dismissal. */
export async function restoreReceipt(companyId: string, receiptId: string) {
  const receipt = await prisma.receiptUpload.findFirst({
    where: { id: receiptId, companyId, status: "DISMISSED" },
  });
  if (!receipt) throw new PostingError("Dismissed receipt not found in this company");
  return prisma.receiptUpload.update({
    where: { id: receipt.id },
    data: { status: receipt.readAt ? "READY" : "PENDING", dismissedAt: null, dismissedReason: null },
  });
}
