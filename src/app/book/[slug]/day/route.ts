import { offeredDates, publicVenue } from "@/lib/bookings/book";
import { dayPayload } from "@/lib/bookings/day-payload";

/**
 * One day of the grid, for the booking page to swap in (SPEC §17).
 *
 * The strip used to navigate: a click re-rendered the whole page on the server
 * to change one table. This answers the only question that actually changed —
 * what is free on that day — and the page redraws the grid in place, keeping
 * the booker's selection and their place on the page.
 *
 * Public, because the page it serves is: a stranger with no account is the
 * whole point of it. The slug decides the venue, the horizon decides which days
 * may be asked for, and the stored rates decide the prices — nothing the
 * request says touches any of that.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const date = new URL(request.url).searchParams.get("date") ?? "";

  const venue = await publicVenue(slug);
  if (!venue) return new Response("Not found", { status: 404 });

  const zone = venue.company.operatingTimeZone;
  // A day outside what the venue offers is not a day: no probing the calendar
  // for what a venue looked like last year, or will look like in ten.
  if (!offeredDates(venue.settings, zone).includes(date)) {
    return new Response("Not found", { status: 404 });
  }

  const payload = await dayPayload({
    settings: venue.settings,
    units: venue.units,
    rates: venue.rates,
    date,
    timeZone: zone,
  });

  return Response.json(payload, {
    // Never cached: a slot taken ten seconds ago must not still look free, and
    // the whole value of this grid is that it is current.
    headers: { "cache-control": "no-store" },
  });
}
