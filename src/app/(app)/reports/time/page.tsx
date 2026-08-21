import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { timesheet } from "@/lib/time/report";
import {
  formatDayLabel,
  formatDuration,
  weekBounds,
  zoneAbbreviation,
} from "@/lib/time/zone";
import { Button, Card, DataTable, EmptyState, Field, Input, PageHeader } from "@/components/ui";

export const metadata = { title: "Time report — Ledger" };

/** SPEC §12.7: hours per consultant per day/week/period, in the clock's zone. */
export default async function TimeReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const params = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const zone = company.timeClockTimeZone;
  const label = zoneAbbreviation(new Date(), zone);
  const thisWeek = weekBounds(new Date(), zone);

  const fromDayKey = params.from ?? thisWeek.dayKeys[0];
  const toDayKey = params.to ?? thisWeek.dayKeys[6];

  const sheet = await timesheet({
    companyId: scope.companyId,
    timeZone: zone,
    fromDayKey,
    toDayKey,
  });

  return (
    <>
      <PageHeader
        title="Time report"
        description={`${company.name} · ${formatDayLabel(fromDayKey, zone)} to ${formatDayLabel(
          toDayKey,
          zone,
        )} · all times ${label}`}
      />

      <Card className="mb-4 print:hidden">
        <form className="flex flex-wrap items-end gap-3">
          <Field label="From">
            <Input type="date" name="from" defaultValue={fromDayKey} />
          </Field>
          <Field label="To">
            <Input type="date" name="to" defaultValue={toDayKey} />
          </Field>
          <Button type="submit">Update</Button>
          <a href={`/reports/time/csv?from=${fromDayKey}&to=${toDayKey}`}>
            <Button variant="secondary" type="button">
              Export CSV
            </Button>
          </a>
        </form>
      </Card>

      {sheet.rows.length === 0 ? (
        <EmptyState title="No time recorded in this period" />
      ) : (
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Consultant</th>
                <th className="py-2 text-right">Days worked</th>
                <th className="py-2 text-right">Hours</th>
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row) => (
                <tr key={row.consultantId} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2">{row.consultantName}</td>
                  <td className="py-2 text-right tabular-nums">{row.cells.size}</td>
                  <td className="py-2 text-right tabular-nums">{formatDuration(row.totalMinutes)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
                <td className="py-2">Total</td>
                <td />
                <td className="py-2 text-right tabular-nums">{formatDuration(sheet.totalMinutes)}</td>
              </tr>
            </tfoot>
          </DataTable>
        </Card>
      )}
    </>
  );
}
