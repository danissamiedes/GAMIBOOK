import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { ClockError, adminUpsertEntry, autoCloseStaleEntries } from "@/lib/time/clock";
import { flaggedEntries, openEntries, timesheet } from "@/lib/time/report";
import {
  formatDayLabel,
  formatDuration,
  formatTimeInZone,
  parseLocalDateTime,
  toLocalInputValue,
  weekBounds,
  workDayKey,
  zoneAbbreviation,
} from "@/lib/time/zone";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: "Timesheets — Ledger" };

/** Admin timesheet grid: consultant × day, in the clock's zone (SPEC §9). */
export default async function TimesheetsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; error?: string; saved?: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const params = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const zone = company.timeClockTimeZone;
  const label = zoneAbbreviation(new Date(), zone);

  const thisWeek = weekBounds(new Date(), zone);
  const fromDayKey = params.from ?? thisWeek.dayKeys[0];
  const toDayKey = params.to ?? thisWeek.dayKeys[6];

  const [sheet, open, flagged, consultants] = await Promise.all([
    timesheet({ companyId: scope.companyId, timeZone: zone, fromDayKey, toDayKey }),
    openEntries(scope.companyId),
    flaggedEntries(scope.companyId),
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "CONSULTANT", isActive: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const entries = await prisma.timeEntry.findMany({
    where: {
      ...scope.where,
      clockInAt: {
        gte: new Date(`${fromDayKey}T00:00:00Z`),
      },
    },
    include: { consultant: { select: { name: true } } },
    orderBy: { clockInAt: "desc" },
    take: 200,
  });

  async function saveEntry(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const innerCompany = await prisma.company.findFirstOrThrow({ where: { id: inner.companyId } });
    const innerZone = innerCompany.timeClockTimeZone;

    const clockInAt = parseLocalDateTime(String(formData.get("clockInAt") || ""), innerZone);
    const clockOutRaw = String(formData.get("clockOutAt") || "");
    const clockOutAt = clockOutRaw ? parseLocalDateTime(clockOutRaw, innerZone) : null;
    if (!clockInAt) redirect("/timesheets?error=Enter%20a%20valid%20start%20time");

    try {
      await adminUpsertEntry({
        companyId: inner.companyId,
        entryId: String(formData.get("entryId") || "") || null,
        consultantId: String(formData.get("consultantId")),
        clockInAt: clockInAt!,
        clockOutAt,
        note: String(formData.get("note") || "").trim() || null,
        editReason: String(formData.get("editReason") || ""),
        userId: inner.userId,
      });
    } catch (error) {
      if (error instanceof ClockError) {
        redirect(`/timesheets?error=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }
    redirect("/timesheets?saved=1");
  }

  async function closeStale() {
    "use server";
    await sectionScope("CONSULTANTS");
    await autoCloseStaleEntries();
    redirect("/timesheets?saved=1");
  }

  return (
    <>
      <PageHeader
        title="Timesheets"
        description={`${company.name} · ${formatDayLabel(fromDayKey, zone)} to ${formatDayLabel(
          toDayKey,
          zone,
        )} · all times ${label}`}
      />

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      {params.saved ? <Alert tone="success">Saved.</Alert> : null}

      <Card className="mb-4 print:hidden">
        <form className="flex flex-wrap items-end gap-3">
          <Field label="From">
            <Input type="date" name="from" defaultValue={fromDayKey} />
          </Field>
          <Field label="To">
            <Input type="date" name="to" defaultValue={toDayKey} />
          </Field>
          <Button type="submit">Update</Button>
          <a href={`/reports/time?from=${fromDayKey}&to=${toDayKey}`}>
            <Button variant="secondary" type="button">
              Time report
            </Button>
          </a>
        </form>
      </Card>

      {open.length > 0 ? (
        <Alert tone="warning">
          <strong>{open.length} shift{open.length === 1 ? "" : "s"} still running:</strong>{" "}
          {open
            .map(
              (entry) =>
                `${entry.consultant.name} since ${formatTimeInZone(entry.clockInAt, zone)} ${label} on ${formatDayLabel(
                  workDayKey(entry.clockInAt, zone),
                  zone,
                )}`,
            )
            .join("; ")}
          .
          <form action={closeStale} className="mt-2">
            <Button variant="secondary" type="submit">
              Auto-close anything past the {company.maxShiftHours}h limit
            </Button>
          </form>
        </Alert>
      ) : null}

      {flagged.length > 0 ? (
        <Alert tone="info">
          {flagged.length} entr{flagged.length === 1 ? "y has" : "ies have"} a correction request
          waiting: {flagged.map((entry) => entry.consultant.name).join(", ")}.
        </Alert>
      ) : null}

      <Card className="mt-4 overflow-x-auto">
        {sheet.rows.length === 0 ? (
          <EmptyState title="No time recorded in this period" />
        ) : (
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Consultant</th>
                {sheet.dayKeys.map((dayKey) => (
                  <th key={dayKey} className="py-2 text-right">
                    {formatDayLabel(dayKey, zone).replace(/ \d{4}$/, "")}
                  </th>
                ))}
                <th className="py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row) => (
                <tr key={row.consultantId} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2">{row.consultantName}</td>
                  {sheet.dayKeys.map((dayKey) => {
                    const cell = row.cells.get(dayKey);
                    return (
                      <td key={dayKey} className="py-2 text-right tabular-nums">
                        {cell ? (
                          <span
                            className={
                              cell.hasFlag
                                ? "text-amber-700 dark:text-amber-300"
                                : cell.hasOpenEntry
                                  ? "text-blue-700 dark:text-blue-300"
                                  : ""
                            }
                          >
                            {formatDuration(cell.minutes)}
                            {cell.hasOpenEntry ? " ·" : ""}
                          </span>
                        ) : (
                          <span className="text-slate-300 dark:text-slate-700">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="py-2 text-right font-medium tabular-nums">
                    {formatDuration(row.totalMinutes)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
                <td className="py-2">Total</td>
                {sheet.dayKeys.map((dayKey) => (
                  <td key={dayKey} className="py-2 text-right tabular-nums">
                    {formatDuration(sheet.dayTotals.get(dayKey) ?? 0)}
                  </td>
                ))}
                <td className="py-2 text-right tabular-nums">{formatDuration(sheet.totalMinutes)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Entries</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Day</th>
                <th className="py-2">Consultant</th>
                <th className="py-2">In</th>
                <th className="py-2">Out</th>
                <th className="py-2 text-right">Hours</th>
                <th className="py-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2">{formatDayLabel(workDayKey(entry.clockInAt, zone), zone)}</td>
                  <td className="py-2">{entry.consultant.name}</td>
                  <td className="py-2">{formatTimeInZone(entry.clockInAt, zone)}</td>
                  <td className="py-2">
                    {entry.clockOutAt ? formatTimeInZone(entry.clockOutAt, zone) : "running"}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {entry.durationMinutes === null ? "—" : formatDuration(entry.durationMinutes)}
                  </td>
                  <td className="py-2 text-xs text-slate-500">
                    {entry.source.toLowerCase().replace(/_/g, " ")}
                    {entry.correctionRequest && !entry.correctionResolvedAt ? (
                      <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                        flagged
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.some((entry) => entry.correctionRequest && !entry.correctionResolvedAt) ? (
            <div className="mt-4 space-y-2">
              {entries
                .filter((entry) => entry.correctionRequest && !entry.correctionResolvedAt)
                .map((entry) => (
                  <p key={entry.id} className="text-xs text-amber-800 dark:text-amber-200">
                    <strong>{entry.consultant.name}</strong> on{" "}
                    {formatDayLabel(workDayKey(entry.clockInAt, zone), zone)}: {entry.correctionRequest}
                  </p>
                ))}
            </div>
          ) : null}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">Add or correct an entry</h2>
          <form action={saveEntry} className="space-y-3">
            <Field label="Entry id" hint="Leave blank to add a new entry.">
              <Input name="entryId" placeholder="(new entry)" />
            </Field>
            <Field label="Consultant">
              <Select name="consultantId" defaultValue={consultants[0]?.id}>
                {consultants.map((consultant) => (
                  <option key={consultant.id} value={consultant.id}>
                    {consultant.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`Clock in (${label})`}>
              <Input
                type="datetime-local"
                name="clockInAt"
                defaultValue={toLocalInputValue(new Date(), zone)}
                required
              />
            </Field>
            <Field label={`Clock out (${label})`} hint="Leave blank for a shift still running.">
              <Input type="datetime-local" name="clockOutAt" />
            </Field>
            <Field label="Note">
              <Input name="note" />
            </Field>
            <Field label="Reason" hint="Required. It goes in the audit trail.">
              <Input name="editReason" required />
            </Field>
            <Button type="submit">Save entry</Button>
          </form>
          <p className="mt-3 text-xs text-slate-500">
            Original times are kept on every edit, alongside who changed them and why.{" "}
            <Link className="underline" href="/reports/time">
              Time report
            </Link>
          </p>
        </Card>
      </div>
    </>
  );
}
