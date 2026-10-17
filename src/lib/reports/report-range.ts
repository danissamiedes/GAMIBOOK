import { prisma } from "@/lib/db";
import { fiscalYearStart } from "@/lib/dates";
import {
  resolvePeriod,
  resolveReportPeriod,
  type PeriodKey,
  type PeriodParams,
} from "@/lib/reports/date-filter";

/**
 * The dates a report is drawn between, with "All" resolved against the books.
 *
 * "All" is the one period whose start nothing but the database knows: it is
 * the first thing ever posted. Reports ask for it here rather than guessing
 * a floor date, because a profit and loss headed "01/01/1900" is not a
 * report anybody wants to read.
 */
export async function reportRange(
  companyId: string,
  params: PeriodParams,
  today: Date,
  fiscalYearStartMonth = 1,
): Promise<{ key: PeriodKey; from: Date; to: Date }> {
  const period = resolveReportPeriod(params, today, fiscalYearStartMonth);
  if (period.from) return { ...period, from: period.from };

  const first = await prisma.journalEntry.aggregate({
    where: { companyId },
    _min: { date: true },
  });

  return {
    ...period,
    // An empty set of books has no "all": the financial year is as good an
    // answer as any, and it is the one every other default uses.
    from: first._min.date ?? fiscalYearStart(today, fiscalYearStartMonth),
  };
}

/**
 * The same, for a screen that is happy with an open start — an account's
 * running balance "up to" a date, which is what drilling in from a balance
 * sheet asks for.
 */
export function openEndedRange(
  params: PeriodParams,
  today: Date,
  fiscalYearStartMonth = 1,
) {
  const period = resolvePeriod(params, today, fiscalYearStartMonth);
  return { key: period.key, from: period.from, to: period.to ?? today };
}
