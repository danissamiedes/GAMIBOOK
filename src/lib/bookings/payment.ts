import type { BookingGroup } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CompanyScope } from "@/lib/company-scope";
import { writeAudit } from "@/lib/audit";
import { storage, storageKeys, withStorage } from "@/lib/storage";
import { sendEmail } from "@/lib/email/send";
import { formatMoney } from "@/lib/currency";
import { formatAccountingDate } from "@/lib/dates";
import { formatMinute } from "./slots";
import { isExpiredHold } from "./expire";

/**
 * Proof of payment, and the person who checks it (SPEC §17).
 *
 * No money moves through this app. The booker pays however the venue asks —
 * a transfer, a wallet, cash at the desk — and uploads evidence. A human looks
 * at that evidence and says yes. That is the whole mechanism, and it is
 * deliberately the whole mechanism: a system that cannot take money cannot
 * mislay it, and the venue already knows how to read its own bank statement.
 *
 * Every email here is a reply to something a person just did — uploaded proof,
 * pressed Confirm. Nothing in this file sends on a schedule or on its own.
 */

export const MAX_PROOF_BYTES = 10 * 1024 * 1024;

const PROOF_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];

export type ProofProblem =
  | "notFound"
  | "closed"
  | "expired"
  | "file"
  | "type"
  | "size"
  | "already";

export const PROOF_MESSAGES: Record<ProofProblem, string> = {
  notFound: "That booking reference was not found.",
  closed: "This booking is no longer waiting for payment.",
  expired:
    "The hold on these slots ran out, so they are open again. Please pick your times once more.",
  file: "Attach a screenshot or receipt showing the payment.",
  type: "That file type cannot be read. Use a photo, a screenshot or a PDF.",
  size: "That file is over 10 MB. A screenshot is usually well under 1 MB.",
  already: "Payment for this booking has already been submitted.",
};

export type ProofResult = { ok: true; group: BookingGroup } | { ok: false; problem: ProofProblem };

/**
 * The booker uploads evidence. Their slot stops expiring and a person is told.
 *
 * The hold is cleared rather than extended: somebody has now paid real money,
 * and a background sweep taking their court back because an admin was asleep
 * would be indefensible.
 */
export async function submitProof(options: {
  slug: string;
  reference: string;
  file: { name: string; bytes: Buffer; mimeType: string | null };
  paymentReference?: string | null;
  paymentNote?: string | null;
}): Promise<ProofResult> {
  const settings = await prisma.bookingSettings.findUnique({
    where: { slug: options.slug },
    include: { company: { select: { id: true, name: true, baseCurrency: true, email: true } } },
  });
  if (!settings) return { ok: false, problem: "notFound" };

  const booking = await prisma.bookingGroup.findFirst({
    where: {
      companyId: settings.companyId,
      reference: options.reference.trim().toUpperCase(),
    },
    include: { bookings: { include: { unit: true }, orderBy: [{ date: "asc" }, { startMinute: "asc" }] } },
  });
  if (!booking) return { ok: false, problem: "notFound" };
  if (booking.status === "CANCELLED") return { ok: false, problem: "closed" };
  if (booking.status === "CONFIRMED") return { ok: false, problem: "already" };
  if (booking.status === "PAYMENT_SUBMITTED") return { ok: false, problem: "already" };
  // Checked at read time rather than trusting a sweep to have run: the slots
  // are already back on the grid the moment the minute passes, and taking a
  // payment for them after that is how two people arrive for one court.
  if (isExpiredHold(booking)) return { ok: false, problem: "expired" };

  if (options.file.bytes.length === 0) return { ok: false, problem: "file" };
  if (options.file.bytes.length > MAX_PROOF_BYTES) return { ok: false, problem: "size" };
  if (options.file.mimeType && !PROOF_TYPES.includes(options.file.mimeType)) {
    return { ok: false, problem: "type" };
  }

  const fileKey = storageKeys.bookingProof(settings.companyId, booking.id, options.file.name);
  await withStorage("upload", () =>
    storage().put(fileKey, options.file.bytes, options.file.mimeType ?? undefined),
  );

  const updated = await prisma.bookingGroup.update({
    where: { id: booking.id },
    data: {
      status: "PAYMENT_SUBMITTED",
      // The slots carry the status too, because the unique index that stops
      // double-booking reads it on the slot row.
      bookings: { updateMany: { where: {}, data: { status: "PAYMENT_SUBMITTED" } } },
      paymentProofKey: fileKey,
      paymentProofName: options.file.name,
      paymentReference: options.paymentReference?.trim() || null,
      paymentNote: options.paymentNote?.trim() || null,
      paymentSubmittedAt: new Date(),
      // Paid, pending a look. Nothing may take this slot back now.
      heldUntil: null,
    },
  });

  const when = describeSlots(booking);
  const amount = formatMoney(booking.amount.toFixed(2), booking.currency);

  // Both emails are best-effort. A venue with no mailbox connected yet must
  // still be able to take bookings, and a booking already paid for must not be
  // lost because a mail server was slow.
  await notify({
    companyId: settings.companyId,
    to: [settings.notifyEmail || settings.company.email || ""].filter(Boolean),
    subject: `Payment to check — ${booking.reference}`,
    body: [
      `${booking.customerName} says they have paid.`,
      "",
      when,
      `Amount: ${amount}`,
      `Reference: ${booking.reference}`,
      options.paymentReference ? `Their payment reference: ${options.paymentReference}` : "",
      "",
      "Open the booking in GAMIBOOK to see the proof and confirm it.",
    ]
      .filter(Boolean)
      .join("\n"),
    relatedId: booking.id,
  });

  await notify({
    companyId: settings.companyId,
    to: [booking.customerEmail],
    subject: `We have your payment details — ${booking.reference}`,
    body: [
      `Hi ${booking.customerName},`,
      "",
      `Thank you — we have received your proof of payment.`,
      "",
      when,
      `Amount: ${amount}`,
      `Reference: ${booking.reference}`,
      "",
      "Somebody will check it shortly and you will get another email once your booking is confirmed.",
      "",
      settings.company.name,
    ].join("\n"),
    relatedId: booking.id,
  });

  return { ok: true, group: updated };
}

/** Confirm a payment somebody has looked at. One click, one email. */
export async function confirmBooking(
  scope: CompanyScope,
  bookingId: string,
): Promise<{ ok: true; group: BookingGroup } | { ok: false; reason: string }> {
  const booking = await prisma.bookingGroup.findFirst({
    where: { id: bookingId, ...scope.where },
    include: {
      bookings: { include: { unit: true }, orderBy: [{ date: "asc" }, { startMinute: "asc" }] },
      company: { select: { name: true } },
    },
  });
  if (!booking) return { ok: false, reason: "That booking is no longer here." };
  if (booking.status === "CONFIRMED") {
    return { ok: false, reason: "This booking is already confirmed." };
  }
  if (booking.status === "CANCELLED") {
    return { ok: false, reason: "This booking was cancelled." };
  }

  const updated = await prisma.bookingGroup.update({
    where: { id: booking.id },
    data: {
      status: "CONFIRMED",
      confirmedAt: new Date(),
      confirmedByUserId: scope.userId,
      heldUntil: null,
      bookings: { updateMany: { where: {}, data: { status: "CONFIRMED" } } },
    },
  });

  await writeAudit({
    companyId: scope.companyId,
    userId: scope.userId,
    action: "booking.confirmed",
    entityType: "Booking",
    entityId: booking.id,
    summary: `${booking.reference} — ${booking.bookings.length} slot(s)`,
  });

  await notify({
    companyId: scope.companyId,
    to: [booking.customerEmail],
    subject: `Booking confirmed — ${booking.reference}`,
    body: [
      `Hi ${booking.customerName},`,
      "",
      `Your payment has been checked and your booking is confirmed.`,
      "",
      describeSlots(booking),
      `Amount: ${formatMoney(booking.amount.toFixed(2), booking.currency)}`,
      `Reference: ${booking.reference}`,
      "",
      "See you then.",
      "",
      booking.company.name,
    ].join("\n"),
    relatedId: booking.id,
  });

  return { ok: true, group: updated };
}

/** Turn a booking down, with a reason the booker is told. */
export async function rejectBooking(
  scope: CompanyScope,
  bookingId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const booking = await prisma.bookingGroup.findFirst({
    where: { id: bookingId, ...scope.where },
    include: {
      bookings: { include: { unit: true }, orderBy: [{ date: "asc" }, { startMinute: "asc" }] },
      company: { select: { name: true } },
    },
  });
  if (!booking) return { ok: false, reason: "That booking is no longer here." };
  if (booking.status === "CANCELLED") return { ok: false, reason: "Already cancelled." };

  const explanation = reason.trim() || "The venue could not confirm this booking.";

  await prisma.bookingGroup.update({
    where: { id: booking.id },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelReason: explanation,
      heldUntil: null,
      // Cancelling releases every slot: the partial unique index ignores a
      // cancelled row, so the courts go back on the market immediately.
      bookings: { updateMany: { where: {}, data: { status: "CANCELLED" } } },
    },
  });

  await writeAudit({
    companyId: scope.companyId,
    userId: scope.userId,
    action: "booking.cancelled",
    entityType: "Booking",
    entityId: booking.id,
    summary: `${booking.reference} — ${explanation}`,
  });

  await notify({
    companyId: scope.companyId,
    to: [booking.customerEmail],
    subject: `Booking cancelled — ${booking.reference}`,
    body: [
      `Hi ${booking.customerName},`,
      "",
      `We are sorry — your booking has been cancelled.`,
      "",
      describeSlots(booking),
      `Reference: ${booking.reference}`,
      "",
      explanation,
      "",
      "If you have already paid, please contact us and we will sort it out.",
      "",
      booking.company.name,
    ].join("\n"),
    relatedId: booking.id,
  });

  return { ok: true };
}

/**
 * Send, and never let the send break what it is reporting on.
 *
 * A venue that has not connected a mailbox yet must still be able to take
 * bookings, and a booking somebody has already paid for must not be lost
 * because a mail server was slow. The attempt is recorded in the email log
 * either way, so a missing confirmation is visible rather than silent.
 */
async function notify(options: {
  companyId: string;
  to: string[];
  subject: string;
  body: string;
  relatedId: string;
}): Promise<void> {
  if (options.to.length === 0) return;
  try {
    await sendEmail({
      companyId: options.companyId,
      email: {
        to: options.to,
        cc: [],
        subject: options.subject,
        body: options.body,
        attachments: [],
        relatedType: "Booking",
        relatedId: options.relatedId,
      },
    });
  } catch {
    // Already written to the email log by sendEmail.
  }
}

/**
 * The slots in a group, as a person reads them.
 *
 * Listed under each day, because a booking is no longer one day: somebody who
 * took Monday and Wednesday needs to see both, and a flat list of times that
 * has lost which day it belongs to is worse than useless to the person turning
 * up. One slot on one day still reads as two short lines.
 */
function describeSlots(group: {
  bookings: { unit: { name: string }; date: Date; startMinute: number; endMinute: number }[];
}): string {
  const sorted = group.bookings
    .slice()
    .sort(
      (a, b) =>
        a.date.getTime() - b.date.getTime() ||
        a.startMinute - b.startMinute ||
        a.unit.name.localeCompare(b.unit.name),
    );

  const out: string[] = [];
  let currentDay = "";
  for (const slot of sorted) {
    const day = formatAccountingDate(slot.date);
    if (day !== currentDay) {
      out.push(`${out.length === 0 ? "When: " : "      "}${day}`);
      currentDay = day;
    }
    out.push(
      `  ${slot.unit.name}: ${formatMinute(slot.startMinute)} – ${formatMinute(slot.endMinute)}`,
    );
  }
  return out.join("\n");
}
