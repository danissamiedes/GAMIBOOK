import { fiscalYearStart, formatAccountingDate, today } from "@/lib/dates";

/** The presets every report offers (SPEC §12). */
export function periodPresets(fiscalYearStartMonth: number, basePath: string) {
  const now = today();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const range = (from: Date, to: Date, label: string) => ({
    label,
    href: `${basePath}?from=${formatAccountingDate(from)}&to=${formatAccountingDate(to)}`,
  });

  const monthStart = new Date(Date.UTC(year, month, 1));
  const monthEnd = new Date(Date.UTC(year, month + 1, 0));
  const lastMonthStart = new Date(Date.UTC(year, month - 1, 1));
  const lastMonthEnd = new Date(Date.UTC(year, month, 0));
  const quarterStart = new Date(Date.UTC(year, Math.floor(month / 3) * 3, 1));
  const quarterEnd = new Date(Date.UTC(year, Math.floor(month / 3) * 3 + 3, 0));
  const fyStart = fiscalYearStart(now, fiscalYearStartMonth);
  const fyEnd = new Date(Date.UTC(fyStart.getUTCFullYear() + 1, fyStart.getUTCMonth(), 0));
  const priorFyStart = new Date(Date.UTC(fyStart.getUTCFullYear() - 1, fyStart.getUTCMonth(), 1));
  const priorFyEnd = new Date(fyStart.getTime() - 86_400_000);

  return [
    range(monthStart, monthEnd, "This month"),
    range(lastMonthStart, lastMonthEnd, "Last month"),
    range(quarterStart, quarterEnd, "This quarter"),
    range(fyStart, fyEnd, "This year"),
    range(priorFyStart, priorFyEnd, "Last year"),
  ];
}

export function asOfPresets(fiscalYearStartMonth: number, basePath: string) {
  const now = today();
  const fyStart = fiscalYearStart(now, fiscalYearStartMonth);
  const fyEnd = new Date(Date.UTC(fyStart.getUTCFullYear() + 1, fyStart.getUTCMonth(), 0));
  const priorFyEnd = new Date(fyStart.getTime() - 86_400_000);
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));

  const at = (date: Date, label: string) => ({
    label,
    href: `${basePath}?asOf=${formatAccountingDate(date)}`,
  });

  return [
    at(now, "Today"),
    at(monthEnd, "End of this month"),
    at(fyEnd, "End of this year"),
    at(priorFyEnd, "End of last year"),
  ];
}
