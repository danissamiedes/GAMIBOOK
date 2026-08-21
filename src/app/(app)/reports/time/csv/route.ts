import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { timesheet } from "@/lib/time/report";
import { csvResponse } from "@/lib/reports/csv";
import { formatDuration, weekBounds, zoneAbbreviation } from "@/lib/time/zone";

export async function GET(request: Request) {
  const scope = await sectionScope("CONSULTANTS");
  const url = new URL(request.url);

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const zone = company.timeClockTimeZone;
  const thisWeek = weekBounds(new Date(), zone);
  const fromDayKey = url.searchParams.get("from") ?? thisWeek.dayKeys[0];
  const toDayKey = url.searchParams.get("to") ?? thisWeek.dayKeys[6];

  const sheet = await timesheet({
    companyId: scope.companyId,
    timeZone: zone,
    fromDayKey,
    toDayKey,
  });

  const rows: unknown[][] = [
    [company.name],
    ["Time report"],
    [`${fromDayKey} to ${toDayKey}`],
    [`All times ${zoneAbbreviation(new Date(), zone)} (${zone})`],
    [],
    ["Consultant", ...sheet.dayKeys, "Total hours", "Total minutes"],
    ...sheet.rows.map((row) => [
      row.consultantName,
      ...sheet.dayKeys.map((dayKey) => {
        const minutes = row.cells.get(dayKey)?.minutes ?? 0;
        return minutes === 0 ? "" : (minutes / 60).toFixed(2);
      }),
      formatDuration(row.totalMinutes),
      row.totalMinutes,
    ]),
    [
      "Total",
      ...sheet.dayKeys.map((dayKey) => ((sheet.dayTotals.get(dayKey) ?? 0) / 60).toFixed(2)),
      formatDuration(sheet.totalMinutes),
      sheet.totalMinutes,
    ],
  ];

  return csvResponse(rows, `TimeReport-${fromDayKey}-to-${toDayKey}.csv`);
}
