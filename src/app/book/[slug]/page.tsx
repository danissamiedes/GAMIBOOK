import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { APP_NAME, pageTitle } from "@/lib/brand";
import {
  BOOK_MESSAGES,
  createBooking,
  dayGrid,
  offeredDates,
  publicVenue,
  venueToday,
  type BookProblem,
} from "@/lib/bookings/book";
import { formatMinute } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/currency";
import { parseAccountingDate } from "@/lib/dates";
import { rateLimit } from "@/lib/rate-limit";
import { Alert, Button, Card, Field, Input } from "@/components/ui";

export const metadata = { title: pageTitle("Book") };

/** "Fri 3 Oct" — the date tabs across the top. */
function tabLabel(date: string, today: string): { top: string; day: string; month: string } {
  const parsed = parseAccountingDate(date)!;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parsed.getUTCDay()];
  const month = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ][parsed.getUTCMonth()];
  return {
    top: date === today ? "Today" : weekday,
    day: String(parsed.getUTCDate()),
    month,
  };
}

/**
 * The public booking page (SPEC §17).
 *
 * No account, no session. A stranger arrives from a link, sees what is free,
 * and books. Everything on the page is derived from the slug: which company,
 * which units, which prices. Nothing the browser sends decides any of that.
 */
export default async function BookPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string; unit?: string; start?: string; error?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;

  const venue = await publicVenue(slug);
  if (!venue) notFound();
  const { settings, units, rates, company } = venue;

  const zone = company.operatingTimeZone;
  const dates = offeredDates(settings, zone);
  const today = venueToday(zone);
  const date = query.date && dates.includes(query.date) ? query.date : dates[0];

  const grid = await dayGrid({ settings, units, rates, date, timeZone: zone });

  // The slot being booked, if one was picked.
  const chosen =
    query.unit && query.start ? grid.cells.get(`${query.unit}:${Number(query.start)}`) : undefined;
  const chosenUnit = units.find((unit) => unit.id === query.unit);

  async function book(formData: FormData) {
    "use server";
    // A public endpoint that writes rows: throttled by address, because the
    // cost of abuse is a calendar full of holds nobody intends to pay for.
    const forwarded = (await headers()).get("x-forwarded-for") ?? "unknown";
    const limit = await rateLimit(`book:${forwarded.split(",")[0]!.trim()}`, 10, 900);
    if (!limit.ok) redirect(`/book/${slug}?error=throttled`);

    const result = await createBooking({
      slug,
      unitId: String(formData.get("unitId") || ""),
      date: String(formData.get("date") || ""),
      startMinute: Number(formData.get("startMinute") || 0),
      customerName: String(formData.get("customerName") || ""),
      customerEmail: String(formData.get("customerEmail") || ""),
      customerPhone: String(formData.get("customerPhone") || ""),
      note: String(formData.get("note") || ""),
    });

    if (!result.ok) {
      redirect(
        `/book/${slug}?date=${encodeURIComponent(String(formData.get("date") || ""))}&error=${result.problem}`,
      );
    }
    redirect(`/book/${slug}/${result.booking.reference}`);
  }

  const money = (amount: { toFixed: (n: number) => string } | null) =>
    amount ? formatMoney(amount.toFixed(2), company.baseCurrency) : "—";

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
          {settings.venueName || company.name}
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {[settings.venueAddress, `Open ${formatMinute(settings.opensAtMinute)} – ${formatMinute(settings.closesAtMinute)}`]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {settings.intro ? (
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            {settings.intro}
          </p>
        ) : null}
      </header>

      {query.error ? (
        <Alert tone="error">
          {query.error === "throttled"
            ? "That is a lot of bookings at once. Please wait a few minutes and try again."
            : (BOOK_MESSAGES[query.error as BookProblem] ?? "That booking could not be made.")}
        </Alert>
      ) : null}

      {/* ---- Dates ------------------------------------------------------ */}
      <div className="mb-5 flex gap-2 overflow-x-auto pb-2">
        {dates.map((option) => {
          const label = tabLabel(option, today);
          const active = option === date;
          return (
            <Link
              key={option}
              href={`/book/${slug}?date=${option}`}
              className={`flex min-w-[4.5rem] shrink-0 flex-col items-center rounded-lg border px-3 py-2 text-center transition-colors ${
                active
                  ? "border-brand-600 bg-brand-600 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              }`}
            >
              <span className="text-[10px] font-semibold uppercase tracking-wide opacity-80">
                {label.top}
              </span>
              <span className="text-lg font-bold leading-tight">{label.day}</span>
              <span className="text-[10px] opacity-80">{label.month}</span>
            </Link>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        {/* ---- The grid ------------------------------------------------- */}
        <Card className="overflow-x-auto">
          {units.length === 0 ? (
            <p className="text-sm text-slate-500">
              This venue has not set up its {settings.unitLabelPlural.toLowerCase()} yet.
            </p>
          ) : (
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="w-20 py-2">Time</th>
                  {grid.units.map((unit) => (
                    <th key={unit.id} className="py-2 text-center">
                      {unit.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.slots.map((slot) => (
                  <tr key={slot.startMinute} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-1.5 align-middle text-xs font-medium text-slate-600 dark:text-slate-300">
                      {slot.label}
                      <span className="block text-[10px] text-slate-400">{slot.endLabel}</span>
                    </td>
                    {grid.units.map((unit) => {
                      const cell = grid.cells.get(`${unit.id}:${slot.startMinute}`)!;
                      const picked =
                        query.unit === unit.id && Number(query.start) === slot.startMinute;

                      if (cell.unavailable) {
                        return (
                          <td key={unit.id} className="p-1">
                            <div className="rounded-md border border-dashed border-slate-200 py-2 text-center text-xs text-slate-400 dark:border-slate-800">
                              {cell.unavailable === "taken"
                                ? "Booked"
                                : cell.unavailable === "past"
                                  ? "Passed"
                                  : "—"}
                            </div>
                          </td>
                        );
                      }

                      return (
                        <td key={unit.id} className="p-1">
                          <Link
                            href={`/book/${slug}?date=${date}&unit=${unit.id}&start=${slot.startMinute}`}
                            className={`block rounded-md border py-2 text-center text-xs font-medium transition-colors ${
                              picked
                                ? "border-brand-600 bg-brand-600 text-white"
                                : "border-slate-200 text-brand-700 hover:border-brand-600 hover:bg-brand-50 dark:border-slate-700 dark:text-brand-400 dark:hover:bg-slate-800"
                            }`}
                          >
                            {money(cell.amount)}
                            {cell.rateLabel ? (
                              <span className="block text-[10px] font-normal opacity-80">
                                {cell.rateLabel}
                              </span>
                            ) : null}
                          </Link>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* ---- Your booking --------------------------------------------- */}
        <div>
          <Card>
            <h2 className="mb-1 text-sm font-semibold">Your booking</h2>

            {!chosen || !chosenUnit || chosen.unavailable ? (
              <p className="mt-3 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                Pick a free time from the grid and your booking details appear here.
              </p>
            ) : (
              <form action={book} className="mt-3 space-y-3">
                <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-900/60">
                  <p className="font-semibold text-slate-900 dark:text-white">{chosenUnit.name}</p>
                  <p className="text-slate-600 dark:text-slate-400">
                    {tabLabel(date, today).day} {tabLabel(date, today).month} ·{" "}
                    {chosen.label} – {chosen.endLabel}
                  </p>
                  <p className="mt-1 text-lg font-bold text-slate-900 dark:text-white">
                    {money(chosen.amount)}
                    {chosen.rateLabel ? (
                      <span className="ml-1 text-xs font-normal text-slate-500">
                        {chosen.rateLabel}
                      </span>
                    ) : null}
                  </p>
                </div>

                <input type="hidden" name="unitId" value={chosenUnit.id} />
                <input type="hidden" name="date" value={date} />
                <input type="hidden" name="startMinute" value={chosen.startMinute} />

                <Field label="Your name">
                  <Input name="customerName" required autoComplete="name" />
                </Field>
                <Field label="Email" hint="Your confirmation goes here.">
                  <Input name="customerEmail" type="email" required autoComplete="email" />
                </Field>
                <Field label="Mobile" hint="Optional.">
                  <Input name="customerPhone" autoComplete="tel" />
                </Field>
                <Field label="Anything we should know?" hint="Optional.">
                  <Input name="note" />
                </Field>

                <Button type="submit" className="w-full">
                  Hold this slot
                </Button>
                <p className="text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  No account needed. We hold it for {settings.holdMinutes} minutes while you pay —
                  payment details come next.
                </p>
              </form>
            )}
          </Card>

          <p className="mt-4 text-center text-xs text-slate-500 dark:text-slate-400">
            Already booked?{" "}
            <Link href={`/book/${slug}/find`} className="underline">
              Find your booking
            </Link>
          </p>
          <p className="mt-6 text-center text-xs text-slate-400">Powered by {APP_NAME}</p>
        </div>
      </div>
    </main>
  );
}
