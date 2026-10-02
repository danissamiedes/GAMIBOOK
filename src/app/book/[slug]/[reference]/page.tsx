import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { bookingByReference, publicVenue } from "@/lib/bookings/book";
import { formatMinute } from "@/lib/bookings/slots";
import { PROOF_MESSAGES, submitProof, type ProofProblem } from "@/lib/bookings/payment";
import { formatMoney } from "@/lib/currency";
import { formatAccountingDate } from "@/lib/dates";
import { Alert, Button, Card, Field, Input } from "@/components/ui";

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

  const status = STATUS_COPY[booking.status];
  const when = `${formatAccountingDate(booking.date)} · ${formatMinute(booking.startMinute)} – ${formatMinute(booking.endMinute)}`;
  const amount = formatMoney(booking.amount.toFixed(2), booking.currency);

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

        <dl className="mt-5 space-y-3 text-sm">
          {[
            { term: venue.settings.unitLabel, detail: booking.unit.name },
            { term: "When", detail: when },
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

      {booking.status === "HELD" ? (
        <Card className="mt-5">
          <h2 className="mb-2 text-sm font-semibold">How to pay</h2>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            {venue.settings.paymentInstructions ||
              "Please contact the venue for payment details."}
          </p>
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            Quote <strong>{booking.reference}</strong> so we can match your payment.
          </p>

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
        <Link href={`/book/${slug}`} className="text-slate-500 underline">
          Back to the schedule
        </Link>
      </p>
    </main>
  );
}
