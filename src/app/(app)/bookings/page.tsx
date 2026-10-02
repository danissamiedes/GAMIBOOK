import Link from "next/link";
import { redirect } from "next/navigation";
import type { BookingStatus } from "@prisma/client";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { confirmBooking, rejectBooking } from "@/lib/bookings/payment";
import { formatMinute } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/currency";
import { formatAccountingDate } from "@/lib/dates";
import { Alert, Button, Card, DataTable, EmptyState, Input, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Bookings") };

const TABS: { key: string; label: string; status?: BookingStatus }[] = [
  { key: "to-check", label: "To check", status: "PAYMENT_SUBMITTED" },
  { key: "held", label: "Awaiting payment", status: "HELD" },
  { key: "confirmed", label: "Confirmed", status: "CONFIRMED" },
  { key: "cancelled", label: "Cancelled", status: "CANCELLED" },
  { key: "all", label: "All" },
];

/**
 * Bookings, and the one button that matters (SPEC §17).
 *
 * Opens on "To check" rather than on everything, because the only thing here
 * that needs a person is a payment somebody has sent proof of. The rest is
 * reference material.
 */
export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; saved?: string; error?: string }>;
}) {
  const scope = await sectionScope("BOOKINGS");
  const { tab, saved, error } = await searchParams;

  const active = TABS.find((candidate) => candidate.key === tab) ?? TABS[0];

  const [bookings, settings, counts] = await Promise.all([
    prisma.booking.findMany({
      where: { ...scope.where, ...(active.status ? { status: active.status } : {}) },
      include: { unit: true },
      orderBy: [{ date: "asc" }, { startMinute: "asc" }],
      take: 200,
    }),
    prisma.bookingSettings.findUnique({ where: { companyId: scope.companyId } }),
    prisma.booking.groupBy({ by: ["status"], where: scope.where, _count: true }),
  ]);

  const countOf = (status?: BookingStatus) =>
    status ? (counts.find((row) => row.status === status)?._count ?? 0) : undefined;

  async function confirm(formData: FormData) {
    "use server";
    const inner = await sectionScope("BOOKINGS");
    const result = await confirmBooking(inner, String(formData.get("bookingId") || ""));
    redirect(
      result.ok
        ? `/bookings?tab=${tab ?? "to-check"}&saved=${encodeURIComponent(
            `Confirmed ${result.booking.reference}. The booker has been emailed.`,
          )}`
        : `/bookings?tab=${tab ?? "to-check"}&error=${encodeURIComponent(result.reason)}`,
    );
  }

  async function reject(formData: FormData) {
    "use server";
    const inner = await sectionScope("BOOKINGS");
    const result = await rejectBooking(
      inner,
      String(formData.get("bookingId") || ""),
      String(formData.get("reason") || ""),
    );
    redirect(
      result.ok
        ? `/bookings?tab=${tab ?? "to-check"}&saved=${encodeURIComponent("Booking cancelled and the booker emailed.")}`
        : `/bookings?tab=${tab ?? "to-check"}&error=${encodeURIComponent(result.reason)}`,
    );
  }

  return (
    <>
      <PageHeader
        title="Bookings"
        description={
          settings?.isPublished
            ? `Taking bookings at /book/${settings.slug}`
            : "The public page is not published yet — see Booking settings."
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((candidate) => {
          const count = countOf(candidate.status);
          return (
            <Link
              key={candidate.key}
              href={`/bookings?tab=${candidate.key}`}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                candidate.key === active.key
                  ? "border-brand-600 bg-brand-600 text-white"
                  : "border-slate-200 text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:text-slate-200"
              }`}
            >
              {candidate.label}
              {count ? <span className="ml-1.5 opacity-80">{count}</span> : null}
            </Link>
          );
        })}
        <span className="grow" />
        <Link href="/bookings/units">
          <Button variant="ghost">{settings?.unitLabelPlural ?? "Units"}</Button>
        </Link>
        <Link href="/bookings/rates">
          <Button variant="ghost">Rates</Button>
        </Link>
        <Link href="/bookings/settings">
          <Button variant="ghost">Settings</Button>
        </Link>
      </div>

      {saved ? <Alert tone="success">{decodeURIComponent(saved)}</Alert> : null}
      {error ? <Alert tone="error">{decodeURIComponent(error)}</Alert> : null}

      <Card>
        {bookings.length === 0 ? (
          <EmptyState title={`Nothing in ${active.label.toLowerCase()}`}>
            {active.key === "to-check"
              ? "When a booker sends proof of payment it lands here for you to check."
              : "Bookings made on the public page appear here."}
          </EmptyState>
        ) : (
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="px-2 py-2">Reference</th>
                <th className="px-2 py-2">When</th>
                <th className="px-2 py-2">{settings?.unitLabel ?? "Unit"}</th>
                <th className="px-2 py-2">Booked by</th>
                <th className="px-2 py-2 text-right">Amount</th>
                <th className="px-2 py-2">Proof</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {bookings.map((booking) => (
                <tr key={booking.id} className="border-b border-slate-100 align-top dark:border-slate-800/60">
                  <td className="px-2 py-2 font-mono text-xs">{booking.reference}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-sm">
                    {formatAccountingDate(booking.date)}
                    <span className="block text-xs text-slate-500">
                      {formatMinute(booking.startMinute)} – {formatMinute(booking.endMinute)}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-sm">{booking.unit.name}</td>
                  <td className="px-2 py-2 text-sm">
                    {booking.customerName}
                    <span className="block text-xs text-slate-500">{booking.customerEmail}</span>
                    {booking.customerPhone ? (
                      <span className="block text-xs text-slate-500">{booking.customerPhone}</span>
                    ) : null}
                  </td>
                  <td className="px-2 py-2 text-right text-sm tabular-nums">
                    {formatMoney(booking.amount.toFixed(2), booking.currency)}
                    {booking.rateLabel ? (
                      <span className="block text-xs text-slate-500">{booking.rateLabel}</span>
                    ) : null}
                  </td>
                  <td className="px-2 py-2 text-sm">
                    {booking.paymentProofKey ? (
                      <a
                        href={`/bookings/proof/${booking.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="underline decoration-dotted underline-offset-2"
                      >
                        View
                      </a>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                    {booking.paymentReference ? (
                      <span className="block text-xs text-slate-500">
                        {booking.paymentReference}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    {booking.status === "CONFIRMED" ? (
                      <span className="text-xs text-emerald-600 dark:text-emerald-400">
                        confirmed
                      </span>
                    ) : booking.status === "CANCELLED" ? (
                      <span className="text-xs text-slate-400">cancelled</span>
                    ) : (
                      <div className="flex flex-col items-end gap-1">
                        <form action={confirm}>
                          <input type="hidden" name="bookingId" value={booking.id} />
                          <Button type="submit">Confirm payment</Button>
                        </form>
                        <form action={reject} className="flex gap-1">
                          <input type="hidden" name="bookingId" value={booking.id} />
                          <Input
                            name="reason"
                            placeholder="Reason"
                            className="h-9 w-28 text-xs"
                            aria-label={`Reason for cancelling ${booking.reference}`}
                          />
                          <Button variant="ghost" type="submit">
                            Cancel
                          </Button>
                        </form>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>
    </>
  );
}
