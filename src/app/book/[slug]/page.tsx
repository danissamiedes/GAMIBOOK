import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { APP_NAME, pageTitle } from "@/lib/brand";
import {
  BOOK_MESSAGES,
  createBookingGroup,
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
 * What a cell nobody can book says, and how it is drawn.
 *
 * Grey fill means gone: somebody paid and a person checked it. A reservation
 * still waiting on payment is drawn differently and says so, because it can
 * still lapse or be turned down and put the slot back on the market — calling
 * that "Booked" claims more than the venue actually has, to a stranger who is
 * deciding whether to come at all.
 */
const UNAVAILABLE: Record<
  "taken" | "pending" | "past" | "no-price",
  { label: string; className: string }
> = {
  taken: {
    label: "Booked",
    className:
      "border-slate-300 bg-slate-200 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400",
  },
  pending: {
    label: "Pending Reservation",
    className:
      "border-dashed border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-300",
  },
  past: {
    label: "Passed",
    className: "border-dashed border-slate-200 text-slate-400 dark:border-slate-800",
  },
  "no-price": {
    label: "—",
    className: "border-dashed border-slate-200 text-slate-400 dark:border-slate-800",
  },
};

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

  // Which slots are ticked, carried in the URL as repeated `pick` params.
  // Server-rendered state rather than client state: the page stays a server
  // component, the back button works, and a half-filled selection survives a
  // refresh or being sent to somebody else.
  const picked = new Set(
    (Array.isArray(query.pick) ? query.pick : query.pick ? [query.pick] : []).filter((key) => {
      // A slot that has since been taken, or is not on this day's grid at all,
      // drops out quietly rather than failing at the end of the form.
      const cell = grid.cells.get(key);
      return cell !== undefined && cell.unavailable === null;
    }),
  );

  const chosenSlots = [...picked]
    .map((key) => ({
      key,
      cell: grid.cells.get(key)!,
      unit: units.find((candidate) => candidate.id === key.split(":")[0])!,
    }))
    .sort(
      (a, b) =>
        a.cell.startMinute - b.cell.startMinute || a.unit.name.localeCompare(b.unit.name),
    );

  const total = chosenSlots.reduce(
    (sum, slot) => sum + Number(slot.cell.amount?.toFixed(2) ?? 0),
    0,
  );

  /** This page with one slot ticked or unticked. */
  const toggleHref = (key: string) => {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    const params = new URLSearchParams();
    params.set("date", date);
    for (const value of next) params.append("pick", value);
    return `/book/${slug}?${params.toString()}`;
  };

  async function book(formData: FormData) {
    "use server";
    // A public endpoint that writes rows: throttled by address, because the
    // cost of abuse is a calendar full of holds nobody intends to pay for.
    const forwarded = (await headers()).get("x-forwarded-for") ?? "unknown";
    const limit = await rateLimit(`book:${forwarded.split(",")[0]!.trim()}`, 10, 900);
    if (!limit.ok) redirect(`/book/${slug}?error=throttled`);

    const chosenDate = String(formData.get("date") || "");
    const picks = formData
      .getAll("pick")
      .map((value) => String(value).split(":"))
      .filter((parts) => parts.length === 2)
      .map(([unitId, startMinute]) => ({ unitId, startMinute: Number(startMinute) }));

    const result = await createBookingGroup({
      slug,
      picks,
      date: chosenDate,
      customerName: String(formData.get("customerName") || ""),
      customerEmail: String(formData.get("customerEmail") || ""),
      customerPhone: String(formData.get("customerPhone") || ""),
      note: String(formData.get("note") || ""),
    });

    if (!result.ok) {
      redirect(`/book/${slug}?date=${encodeURIComponent(chosenDate)}&error=${result.problem}`);
    }
    redirect(`/book/${slug}/${result.group.reference}`);
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
                      const key = `${unit.id}:${slot.startMinute}`;
                      const cell = grid.cells.get(key)!;
                      const isPicked = picked.has(key);

                      if (cell.unavailable) {
                        const state = UNAVAILABLE[cell.unavailable];
                        return (
                          <td key={unit.id} className="p-1">
                            <div
                              className={`rounded-md border px-1 py-2 text-center text-xs leading-tight ${state.className}`}
                            >
                              {state.label}
                            </div>
                          </td>
                        );
                      }

                      return (
                        <td key={unit.id} className="p-1">
                          <Link
                            href={toggleHref(key)}
                            aria-pressed={isPicked}
                            className={`block rounded-md border py-2 text-center text-xs font-medium transition-colors ${
                              isPicked
                                ? "border-brand-600 bg-brand-600 text-white"
                                : "border-slate-200 text-brand-700 hover:border-brand-600 hover:bg-brand-50 dark:border-slate-700 dark:text-brand-400 dark:hover:bg-slate-800"
                            }`}
                          >
                            {money(cell.amount)}
                            {cell.rateLabel ? (
                              <span className="block text-[10px] font-normal opacity-80">
                                {isPicked ? "Selected · tap to remove" : cell.rateLabel}
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

            {chosenSlots.length === 0 ? (
              <p className="mt-3 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                Pick one or more free times from the grid. Tap several to book them together —
                more hours on one {settings.unitLabel.toLowerCase()}, or the same hour across
                a few.
              </p>
            ) : (
              <form action={book} className="mt-3 space-y-3">
                <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-900/60">
                  <p className="font-semibold text-slate-900 dark:text-white">
                    {tabLabel(date, today).day} {tabLabel(date, today).month}
                  </p>
                  <ul className="mt-2 space-y-1">
                    {chosenSlots.map((slot) => (
                      <li key={slot.key} className="flex items-baseline justify-between gap-2">
                        <span className="text-slate-600 dark:text-slate-400">
                          {slot.unit.name} · {slot.cell.label}
                        </span>
                        <span className="flex items-baseline gap-2 whitespace-nowrap">
                          <span className="tabular-nums">{money(slot.cell.amount)}</span>
                          <Link
                            href={toggleHref(slot.key)}
                            aria-label={`Remove ${slot.unit.name} at ${slot.cell.label}`}
                            className="text-xs text-slate-400 underline"
                          >
                            remove
                          </Link>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 flex items-baseline justify-between border-t border-slate-200 pt-2 dark:border-slate-700">
                    <span className="text-xs uppercase tracking-wide text-slate-500">
                      {chosenSlots.length} slot{chosenSlots.length === 1 ? "" : "s"}
                    </span>
                    <span className="text-lg font-bold text-slate-900 dark:text-white">
                      {formatMoney(total.toFixed(2), company.baseCurrency)}
                    </span>
                  </p>
                </div>

                <input type="hidden" name="date" value={date} />
                {chosenSlots.map((slot) => (
                  <input key={slot.key} type="hidden" name="pick" value={slot.key} />
                ))}

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
                  Hold {chosenSlots.length === 1 ? "this slot" : `these ${chosenSlots.length} slots`}
                </Button>
                <p className="text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  No account needed. We hold {chosenSlots.length === 1 ? "it" : "them"} for{" "}
                  {settings.holdMinutes} minutes while you pay — payment details come next. One
                  payment covers everything on this day; another day is booked separately.
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
