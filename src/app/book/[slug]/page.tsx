import Link from "next/link";
import { notFound } from "next/navigation";
import { APP_NAME, pageTitle } from "@/lib/brand";
import {
  BOOK_MESSAGES,
  dayGrid,
  offeredDates,
  publicVenue,
  venueToday,
  type BookProblem,
} from "@/lib/bookings/book";
import { formatMinute } from "@/lib/bookings/slots";
import { parseAccountingDate } from "@/lib/dates";
import { Alert } from "@/components/ui";
import { bookSlots } from "./actions";
import { BookingGrid, type GridCell } from "./grid";

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

  const grid = await dayGrid({ settings, units, rates, date, timeZone: zone });

  // A selection restored from the URL — a refresh, a bookmark, a link somebody
  // was sent. A slot that has since been taken drops out quietly rather than
  // failing at the end of the form.
  const initialPicks = (
    Array.isArray(query.pick) ? query.pick : query.pick ? [query.pick] : []
  ).filter((key) => grid.cells.get(key)?.unavailable === null);

  // Decimal does not cross to the browser, and nor does anything the grid does
  // not draw: the client gets strings it can print and a key it can send back.
  const cells: GridCell[] = [...grid.cells.entries()].map(([key, cell]) => ({
    key,
    startMinute: cell.startMinute,
    label: cell.label,
    amount: cell.amount ? cell.amount.toFixed(2) : null,
    rateLabel: cell.rateLabel,
    unavailable: cell.unavailable,
  }));

  const label = tabLabel(date, today);

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

      {/* ---- Dates ------------------------------------------------------ */}
      <div className="mb-5 flex gap-2 overflow-x-auto pb-2">
        {dates.map((option) => {
          const optionLabel = tabLabel(option, today);
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
                {optionLabel.top}
              </span>
              <span className="text-lg font-bold leading-tight">{optionLabel.day}</span>
              <span className="text-[10px] opacity-80">{optionLabel.month}</span>
            </Link>
          );
        })}
      </div>

      <BookingGrid
        action={bookSlots}
        slug={slug}
        date={date}
        dateLabel={`${label.day} ${label.month}`}
        currency={company.baseCurrency}
        units={grid.units.map((unit) => ({ id: unit.id, name: unit.name }))}
        slots={grid.slots.map((slot) => ({
          startMinute: slot.startMinute,
          label: slot.label,
          endLabel: slot.endLabel,
        }))}
        cells={cells}
        initialPicks={initialPicks}
        unitLabel={settings.unitLabel}
        unitLabelPlural={settings.unitLabelPlural}
        holdMinutes={settings.holdMinutes}
      />

      <p className="mt-6 text-center text-xs text-slate-400">Powered by {APP_NAME}</p>
    </main>
  );
}
