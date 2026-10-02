import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { bookingByReference, publicVenue } from "@/lib/bookings/book";
import { formatMinute } from "@/lib/bookings/slots";
import { PROOF_MESSAGES, submitProof, type ProofProblem } from "@/lib/bookings/payment";
import { formatMoney } from "@/lib/currency";
import { formatAccountingDate } from "@/lib/dates";
import { Alert, Button, Card, Field, Input } from "@/components/ui";
import { HoldCountdown } from "@/components/hold-countdown";
import { isExpiredHold } from "@/lib/bookings/expire";

export const metadata = { title: pageTitle("Your booking") };

const STATUS_COPY = {
  HELD: {
    tone: "warning" as const,
    title: "Held — we need your payment",
    body: "Your slot is reserved. Pay using the details below, then upload a screenshot or receipt so we can check it.",
  },
  PAYMENT_SUBMITTED: {
    tone: "success" as const,
    title: "Payment received — being checked",
    body: "Thank you. Somebody will look at your proof of payment shortly, and you will get an email once your booking is confirmed.",
  },
  CONFIRMED: {
    tone: "success" as const,
    title: "Confirmed — see you then",
    body: "Your payment has been checked and your booking is confirmed.",
  },
  CANCELLED: {
    tone: "error" as const,
    title: "Cancelled",
    body: "This booking is no longer active.",
  },
};

/**
 * A hold whose time ran out reads as its own thing, not as "cancelled".
 *
 * Nobody cancelled it — the clock did — and the next sentence a person needs is
 * what to do about it, which is to pick the times again while they are still
 * free.
 */
const EXPIRED = {
  tone: "error" as const,
  title: "The hold ran out",
  body: "Payment did not arrive in time, so these slots are open again. Pick your times once more to rebook — they may still be free.",
};

/**
 * One booking, as the person who made it sees it (SPEC §17).
 *
 * Reached by its reference, with no account. The reference is the only
 * credential, which is why it is six random characters from a 32-letter
 * alphabet rather than a counter — a sequential number would let anyone read
 * every booking the venue has by counting.
 */
export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; reference: string }>;
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const { slug, reference } = await params;
  const { error, sent } = await searchParams;

  const venue = await publicVenue(slug);
  if (!venue) notFound();

  const booking = await bookingByReference(slug, reference);
  if (!booking) notFound();

  // Worked out here rather than trusted to the sweep: the slots are back on the
  // grid the moment the minute passes, whatever has or has not run since.
  const expired = isExpiredHold(booking);
  const status = expired ? EXPIRED : STATUS_COPY[booking.status];
  const secondsLeft =
    booking.status === "HELD" && booking.heldUntil && !expired
      ? Math.round((booking.heldUntil.getTime() - Date.now()) / 1000)
      : 0;
  const amount = formatMoney(booking.amount.toFixed(2), booking.currency);
  const slots = booking.bookings
    .slice()
    .sort((a, b) => a.startMinute - b.startMinute || a.unit.name.localeCompare(b.unit.name));

  async function upload(formData: FormData) {
    "use server";
    const file = formData.get("proof");
    if (!(file instanceof File) || file.size === 0) {
      redirect(`/book/${slug}/${reference}?error=file`);
    }
    const upload = file as File;

    const result = await submitProof({
      slug,
      reference,
      file: {
        name: upload.name,
        bytes: Buffer.from(await upload.arrayBuffer()),
        mimeType: upload.type || null,
      },
      paymentReference: String(formData.get("paymentReference") || ""),
      paymentNote: String(formData.get("paymentNote") || ""),
    });

    if (!result.ok) redirect(`/book/${slug}/${reference}?error=${result.problem}`);
    redirect(`/book/${slug}/${reference}?sent=1`);
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">
        {venue.settings.venueName || venue.company.name}
      </p>
      <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
        Booking {booking.reference}
      </h1>

      <Card className="mt-5">
        <Alert tone={status.tone}>
          <strong className="block">{status.title}</strong>
          <span className="mt-1 block text-sm">{status.body}</span>
        </Alert>

        {secondsLeft > 0 ? (
          <HoldCountdown seconds={secondsLeft} returnTo={`/book/${slug}?error=expired`} />
        ) : null}

        {/* The slots, listed. One booking can hold several — more hours on one
            court, or the same hour across a few — and flattening them into a
            sentence stops being readable at about three. */}
        <div className="mt-5 rounded-lg bg-slate-50 p-3 dark:bg-slate-900/60">
          <p className="text-xs uppercase tracking-wide text-slate-500">
            {formatAccountingDate(booking.date)}
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {slots.map((slot) => (
              <li key={slot.id} className="flex justify-between gap-3">
                <span className="font-medium text-slate-900 dark:text-white">
                  {slot.unit.name}
                </span>
                <span className="text-slate-600 dark:text-slate-400">
                  {formatMinute(slot.startMinute)} – {formatMinute(slot.endMinute)}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <dl className="mt-5 space-y-3 text-sm">
          {[
            {
              term: slots.length === 1 ? venue.settings.unitLabel : "Slots",
              detail: slots.length === 1 ? slots[0].unit.name : `${slots.length} booked`,
            },
            { term: "Amount", detail: amount },
            { term: "Booked by", detail: booking.customerName },
            { term: "Reference", detail: booking.reference },
          ].map((row) => (
            <div key={row.term} className="flex justify-between gap-4 border-b border-slate-100 pb-2 dark:border-slate-800">
              <dt className="text-slate-500 dark:text-slate-400">{row.term}</dt>
              <dd className="text-right font-medium text-slate-900 dark:text-white">
                {row.detail}
              </dd>
            </div>
          ))}
        </dl>

        {booking.cancelReason ? (
          <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">{booking.cancelReason}</p>
        ) : null}
      </Card>

      {booking.status === "HELD" && !expired ? (
        <Card className="mt-5">
          <h2 className="mb-2 text-sm font-semibold">How to pay</h2>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            {venue.settings.paymentQrKey ? (
              <figure className="shrink-0 text-center">
                {/* Large enough to scan off the screen without pinching, and a
                    white ground regardless of theme — a dark-mode page behind
                    a transparent PNG is a QR that will not read. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/book/${slug}/qr`}
                  alt="Scan this QR code to pay"
                  width={200}
                  height={200}
                  className="size-48 rounded-lg border border-slate-200 bg-white object-contain p-2 dark:border-slate-700"
                />
                <figcaption className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                  Scan to pay
                </figcaption>
              </figure>
            ) : null}

            <div className="min-w-0">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {venue.settings.paymentInstructions ||
                  "Please contact the venue for payment details."}
              </p>
              <p className="mt-3 text-sm text-slate-900 dark:text-white">
                Amount to pay: <strong>{amount}</strong>
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Quote <strong>{booking.reference}</strong> so we can match your payment.
              </p>
            </div>
          </div>

          <form action={upload} className="mt-5 space-y-3 border-t border-slate-200 pt-5 dark:border-slate-700">
            <h3 className="text-sm font-semibold">Send your proof of payment</h3>
            {error ? (
              <Alert tone="error">
                {PROOF_MESSAGES[error as ProofProblem] ?? "That could not be uploaded."}
              </Alert>
            ) : null}

            <Field label="Screenshot or receipt" hint="A photo, a screenshot or a PDF, up to 10 MB.">
              <input
                type="file"
                name="proof"
                required
                accept="image/*,application/pdf"
                className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white"
              />
            </Field>
            <Field label="Payment reference" hint="Optional — the number your bank or wallet gave you.">
              <Input name="paymentReference" />
            </Field>
            <Field label="Note" hint="Optional.">
              <Input name="paymentNote" />
            </Field>

            <Button type="submit" className="w-full">
              Send proof of payment
            </Button>
            <p className="text-center text-xs text-slate-500 dark:text-slate-400">
              Nothing is charged here. We only look at what you send and confirm it.
            </p>
          </form>
        </Card>
      ) : null}

      {sent ? (
        <p className="mt-4 text-center text-sm text-emerald-700 dark:text-emerald-400">
          Thank you — your proof of payment is with us.
        </p>
      ) : null}

      <p className="mt-6 text-center text-sm">
        <Link
          href={`/book/${slug}`}
          className={expired ? "font-medium text-brand-700 underline dark:text-brand-400" : "text-slate-500 underline"}
        >
          {expired ? "Pick your times again" : "Back to the schedule"}
        </Link>
      </p>
    </main>
  );
}
