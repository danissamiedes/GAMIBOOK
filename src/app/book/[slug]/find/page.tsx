import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { bookingByReference, publicVenue } from "@/lib/bookings/book";
import { Alert, Button, Card, Field, Input } from "@/components/ui";

export const metadata = { title: pageTitle("Find your booking") };

/** Look a booking up by the reference the booker was given (SPEC §17). */
export default async function FindBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { slug } = await params;
  const { error } = await searchParams;

  const venue = await publicVenue(slug);
  if (!venue) notFound();

  async function find(formData: FormData) {
    "use server";
    const reference = String(formData.get("reference") || "").trim().toUpperCase();
    const booking = await bookingByReference(slug, reference);
    // One message whether the reference is malformed or simply not ours.
    // Saying which would turn this box into a way to test references.
    if (!booking) redirect(`/book/${slug}/find?error=1`);
    redirect(`/book/${slug}/${booking.reference}`);
  }

  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="mb-1 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
        Find your booking
      </h1>
      <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">
        Enter the reference from your confirmation.
      </p>

      <Card>
        {error ? <Alert tone="error">No booking found with that reference.</Alert> : null}
        <form action={find} className="mt-2 space-y-4">
          <Field label="Reference">
            <Input name="reference" required placeholder="ABC-123" autoCapitalize="characters" />
          </Field>
          <Button type="submit" className="w-full">
            Find it
          </Button>
        </form>
      </Card>

      <p className="mt-6 text-center text-sm">
        <Link href={`/book/${slug}`} className="text-slate-500 underline">
          Back to the schedule
        </Link>
      </p>
    </main>
  );
}
