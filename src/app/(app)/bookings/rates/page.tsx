import Link from "next/link";
import { redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { formatMinute, parseMinute, toTimeInput } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/currency";
import { Alert, Button, Card, DataTable, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("Booking rates") };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * What a slot costs, and when (SPEC §17).
 *
 * Rules rather than a price per slot: the price of a court at 7am and at 7pm
 * differ by time of day and by day of week, and typing a number into every
 * cell of a fourteen-day grid is not something anyone will keep up to date.
 */
export default async function RatesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const scope = await sectionScope("BOOKINGS");
  const { error, saved } = await searchParams;

  const [company, rates, units] = await Promise.all([
    prisma.company.findFirstOrThrow({
      where: { id: scope.companyId },
      select: { baseCurrency: true },
    }),
    prisma.bookingRate.findMany({
      where: scope.where,
      orderBy: [{ priority: "desc" }, { startMinute: "asc" }],
      include: { unit: { select: { name: true } } },
    }),
    prisma.bookableUnit.findMany({
      where: { ...scope.where, isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
  ]);

  async function add(formData: FormData) {
    "use server";
    const inner = await sectionScope("BOOKINGS");

    const label = String(formData.get("label") || "").trim();
    const amount = String(formData.get("amount") || "").trim();
    const start = parseMinute(String(formData.get("startMinute") || ""));
    const end = parseMinute(String(formData.get("endMinute") || ""));
    const days = DAYS.map((_, index) => index).filter(
      (index) => formData.get(`day-${index}`) === "on",
    );

    if (!label) redirect("/bookings/rates?error=label");
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) redirect("/bookings/rates?error=amount");
    if (start === null || end === null) redirect("/bookings/rates?error=time");
    // An empty or backwards window would price nothing and look like a bug in
    // the grid rather than a rule somebody typed wrongly.
    if (end <= start) redirect("/bookings/rates?error=window");

    const unitId = String(formData.get("unitId") || "");
    const rate = await prisma.bookingRate.create({
      data: {
        companyId: inner.companyId,
        label,
        amount,
        daysOfWeek: days,
        startMinute: start,
        endMinute: end,
        unitId: unitId || null,
        priority: Number(formData.get("priority") || 0),
      },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "booking_rate.created",
      entityType: "BookingRate",
      entityId: rate.id,
      summary: `${label} ${amount}`,
    });
    redirect("/bookings/rates?saved=1");
  }

  async function remove(formData: FormData) {
    "use server";
    const inner = await sectionScope("BOOKINGS");
    const id = String(formData.get("rateId") || "");
    // A rate priced past bookings, but each booking stored its own amount and
    // label when it was made, so removing the rule rewrites no history.
    await prisma.bookingRate.deleteMany({ where: { id, ...inner.where } });
    redirect("/bookings/rates?saved=1");
  }

  const MESSAGES: Record<string, string> = {
    label: "Give the rate a name — it is what the booker sees beside the price.",
    amount: "An amount is a number, like 200 or 350.50.",
    time: "Those times could not be read.",
    window: "The finish time has to be after the start time.",
  };

  return (
    <>
      <PageHeader
        title="Booking rates"
        description="A price, and when it applies. Where two overlap, the higher priority wins."
      />

      <div className="mb-4">
        <Link href="/bookings">
          <Button variant="ghost">All bookings</Button>
        </Link>
      </div>

      {error ? <Alert tone="error">{MESSAGES[error] ?? "That rate could not be saved."}</Alert> : null}
      {saved ? <Alert tone="success">Saved.</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          {rates.length === 0 ? (
            <EmptyState title="No rates yet">
              Until there is at least one rate, every slot shows as unavailable — a slot with no
              price is not something to sell.
            </EmptyState>
          ) : (
            <DataTable>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="px-2 py-2">Rate</th>
                  <th className="px-2 py-2 text-right">Amount</th>
                  <th className="px-2 py-2">When</th>
                  <th className="px-2 py-2">Days</th>
                  <th className="px-2 py-2">Applies to</th>
                  <th className="px-2 py-2 text-right">Priority</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {rates.map((rate) => (
                  <tr key={rate.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="px-2 py-2 font-medium">{rate.label}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatMoney(rate.amount.toFixed(2), company.baseCurrency)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-sm">
                      {formatMinute(rate.startMinute)} – {formatMinute(rate.endMinute)}
                    </td>
                    <td className="px-2 py-2 text-sm text-slate-500">
                      {rate.daysOfWeek.length === 0
                        ? "Every day"
                        : rate.daysOfWeek.map((day) => DAYS[day]).join(", ")}
                    </td>
                    <td className="px-2 py-2 text-sm text-slate-500">
                      {rate.unit?.name ?? "All"}
                    </td>
                    <td className="px-2 py-2 text-right text-sm tabular-nums">{rate.priority}</td>
                    <td className="px-2 py-2 text-right">
                      <form action={remove}>
                        <input type="hidden" name="rateId" value={rate.id} />
                        <Button variant="ghost" type="submit">
                          Remove
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>

        <Card tone="muted">
          <h2 className="mb-3 text-sm font-semibold">Add a rate</h2>
          <form action={add} className="space-y-4">
            <Field label="Name" hint="Shown to the booker: Peak, Off-Peak, Member.">
              <Input name="label" required placeholder="Off-Peak" />
            </Field>
            <Field label={`Amount (${company.baseCurrency})`}>
              <Input name="amount" required inputMode="decimal" placeholder="200" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From">
                <Input name="startMinute" type="time" required defaultValue={toTimeInput(420)} />
              </Field>
              <Field label="Until">
                <Input name="endMinute" type="time" required defaultValue={toTimeInput(1020)} />
              </Field>
            </div>
            <fieldset>
              <legend className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
                Days
              </legend>
              <p className="mb-2 text-xs text-slate-500">Leave all unticked for every day.</p>
              <div className="flex flex-wrap gap-2">
                {DAYS.map((day, index) => (
                  <label key={day} className="flex items-center gap-1 text-xs">
                    <input type="checkbox" name={`day-${index}`} className="accent-brand-600" />
                    {day}
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="Applies to" hint="One unit, or all of them.">
              <Select name="unitId" defaultValue="">
                <option value="">All</option>
                {units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority" hint="Higher wins where two rates overlap.">
              <Input name="priority" type="number" defaultValue={0} />
            </Field>
            <Button type="submit">Add rate</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
