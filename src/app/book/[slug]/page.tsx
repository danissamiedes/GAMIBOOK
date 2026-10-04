import { notFound } from "next/navigation";
import { APP_NAME, pageTitle } from "@/lib/brand";
import {
  BOOK_MESSAGES,
  offeredDates,
  publicVenue,
  resolvePicks,
  venueToday,
  type BookProblem,
} from "@/lib/bookings/book";
import { dayPayload } from "@/lib/bookings/day-payload";
import { formatMinute } from "@/lib/bookings/slots";
import { parseAccountingDate } from "@/lib/dates";
import { Alert } from "@/components/ui";
import { bookSlots } from "./actions";
import { BookingGrid } from "./grid";

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
 *
 * The server draws the day and hands it over; picking slots within that day
 * happens in the browser (see grid.tsx), because a round trip per tap is a
 * second of nothing happening in the one interaction everybody uses.
 */
export default async function BookPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string; pick?: string | string[]; error?: string }>;
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

  // The selection, which is not confined to the day on screen: it survives
  // moving along the date strip, because picking Monday and Wednesday is one
  // arrangement and one payment. Slots taken since are dropped here, quietly,
  // rather than failing at the end of the form.
  const picked = await resolvePicks({
    settings,
    units,
    rates,
    timeZone: zone,
    keys: Array.isArray(query.pick) ? query.pick : query.pick ? [query.pick] : [],
  });

  // The same shape the day route serves, so the first paint and every day the
  // browser fetches afterwards are built by one piece of code.
  const day = await dayPayload({ settings, units, rates, date, timeZone: zone });

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
          {settings.venueName || company.name}
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {[
            settings.venueAddress,
            `Open ${formatMinute(settings.opensAtMinute)} – ${formatMinute(settings.closesAtMinute)}`,
          ]
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
            : query.error === "expired"
              ? `Your ${settings.holdMinutes}-minute hold ran out before payment arrived, so those slots are open again. Pick your times to start over.`
              : (BOOK_MESSAGES[query.error as BookProblem] ?? "That booking could not be made.")}
        </Alert>
      ) : null}

      <BookingGrid
        action={bookSlots}
        slug={slug}
        dates={dates.map((option) => ({ date: option, ...tabLabel(option, today) }))}
        currency={company.baseCurrency}
        day={day}
        initialPicks={picked}
        unitLabel={settings.unitLabel}
        unitLabelPlural={settings.unitLabelPlural}
        holdMinutes={settings.holdMinutes}
      />

      <p className="mt-6 text-center text-xs text-slate-400">Powered by {APP_NAME}</p>
    </main>
  );
}
