import type { RecurringFrequency } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { isoDate, parseAccountingDate } from "@/lib/dates";
import { issueInvoice, recalculateTotals } from "./service";

/**
 * Recurring invoices (SPEC §7.2).
 *
 * Two things carry the weight here. The schedule arithmetic, which is where
 * this kind of feature usually goes wrong — "the 31st" in February, a fortnight
 * that must stay on its own cadence rather than drifting to the nearest month.
 * And idempotency, which the spec asks for by name: the job MUST be able to run
 * twice without invoicing a customer twice. That is enforced by a unique
 * constraint on (templateId, scheduledDate) rather than by a check-then-write,
 * because two overlapping runs would both pass a check.
 */

/** The last day of the month containing `date`, as a day number. */
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** A UTC date with the day clamped into the month — "the 31st" of February is the 28th. */
function dateInMonth(year: number, monthIndex: number, day: number): Date {
  const clamped = Math.min(day, daysInMonth(year, monthIndex));
  return new Date(Date.UTC(year, monthIndex, clamped));
}

export type Schedule = {
  frequency: RecurringFrequency;
  startDate: Date;
  dayOfMonth?: number | null;
  dayOfWeek?: number | null;
  monthOfYear?: number | null;
};

/**
 * The first occurrence on or after `from`.
 *
 * Monthly and longer cadences are anchored to a day of the month, so they land
 * on the same day each period regardless of month length. Weekly cadences are
 * anchored to `startDate` itself, which is what keeps a fortnightly schedule on
 * its own two-week rhythm instead of drifting.
 */
export function occurrenceOnOrAfter(schedule: Schedule, from: Date): Date {
  const start = schedule.startDate;
  const target = from > start ? from : start;

  switch (schedule.frequency) {
    case "WEEKLY":
    case "BIWEEKLY": {
      const step = schedule.frequency === "WEEKLY" ? 7 : 14;
      // Anchored on startDate, so every occurrence is a whole number of
      // periods from it — a fortnightly schedule never slides a week.
      const days = Math.round(
        (target.getTime() - start.getTime()) / 86_400_000,
      );
      const periods = Math.max(0, Math.ceil(days / step));
      return new Date(start.getTime() + periods * step * 86_400_000);
    }

    case "MONTHLY":
    case "QUARTERLY": {
      const step = schedule.frequency === "MONTHLY" ? 1 : 3;
      const day = schedule.dayOfMonth ?? start.getUTCDate();
      // Count whole periods from the start month, then walk forward until the
      // candidate is not before the target. Walking rather than computing
      // keeps clamping honest across month lengths.
      let cursor = dateInMonth(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        day,
      );
      let guard = 0;
      while (cursor < target && guard++ < 1200) {
        const next = new Date(
          Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + step, 1),
        );
        cursor = dateInMonth(next.getUTCFullYear(), next.getUTCMonth(), day);
      }
      return cursor;
    }

    case "ANNUALLY": {
      const monthIndex = (schedule.monthOfYear ?? start.getUTCMonth() + 1) - 1;
      const day = schedule.dayOfMonth ?? start.getUTCDate();
      let year = start.getUTCFullYear();
      let cursor = dateInMonth(year, monthIndex, day);
      let guard = 0;
      while (cursor < target && guard++ < 200) {
        year += 1;
        cursor = dateInMonth(year, monthIndex, day);
      }
      return cursor;
    }
  }
}

/** The occurrence strictly after `date`. */
export function occurrenceAfter(schedule: Schedule, date: Date): Date {
  return occurrenceOnOrAfter(schedule, new Date(date.getTime() + 86_400_000));
}

/**
 * Today's date in a company's operating zone.
 *
 * A US company should not invoice on Manila time (SPEC §7.2), and the
 * operating zone is deliberately separate from the time-clock zone.
 */
export function operatingToday(now: Date, operatingTimeZone: string): Date {
  return parseAccountingDate(
    formatInTimeZone(now, operatingTimeZone, "yyyy-MM-dd"),
  )!;
}

/** The local hour in the operating zone, to honour the 06:00 run time. */
export function operatingHour(now: Date, operatingTimeZone: string): number {
  return Number(formatInTimeZone(now, operatingTimeZone, "H"));
}

export type GenerationResult = {
  templateId: string;
  scheduledDate: string;
  invoiceId?: string;
  invoiceNumber?: string | null;
  status: "CREATED" | "ISSUED" | "SKIPPED" | "ALREADY_RUN";
  reason?: string;
};

/**
 * Generate the invoice a template owes for one scheduled date.
 *
 * Everything happens in one transaction whose first act is claiming the
 * (templateId, scheduledDate) row. A concurrent run loses that race on the
 * unique constraint and returns ALREADY_RUN rather than writing a second
 * invoice.
 */
export async function generateOccurrence(options: {
  templateId: string;
  scheduledDate: Date;
}): Promise<GenerationResult> {
  // ISO: this rides along in the result as an identifier beside the
  // (templateId, scheduledDate) unique row, not as something anyone reads.
  const scheduledDate = isoDate(options.scheduledDate);

  const outcome = await prisma
    .$transaction(async (tx) => {
      const template = await tx.recurringInvoiceTemplate.findUniqueOrThrow({
        where: { id: options.templateId },
        include: { lines: { orderBy: { lineNumber: "asc" } }, customer: true },
      });

      // Claim the slot first: if this throws on the unique constraint, nothing
      // else in the transaction has happened.
      const run = await tx.recurringInvoiceRun.create({
        data: { templateId: template.id, scheduledDate: options.scheduledDate },
      });

      const stop = (reason: string): GenerationResult => ({
        templateId: template.id,
        scheduledDate,
        status: "SKIPPED",
        reason,
      });

      if (template.lines.length === 0) {
        await tx.recurringInvoiceRun.update({
          where: { id: run.id },
          data: { skippedReason: "The template has no lines" },
        });
        return stop("The template has no lines");
      }
      if (template.endDate && options.scheduledDate > template.endDate) {
        await tx.recurringInvoiceRun.update({
          where: { id: run.id },
          data: { skippedReason: "Past the template's end date" },
        });
        return stop("Past the template's end date");
      }
      if (
        template.occurrenceLimit !== null &&
        template.occurrenceCount >= template.occurrenceLimit
      ) {
        await tx.recurringInvoiceRun.update({
          where: { id: run.id },
          data: { skippedReason: "Occurrence limit reached" },
        });
        return stop("Occurrence limit reached");
      }

      const dueDate = new Date(
        options.scheduledDate.getTime() +
          template.paymentTermsDays * 86_400_000,
      );

      const invoice = await tx.invoice.create({
        data: {
          companyId: template.companyId,
          customerId: template.customerId,
          issueDate: options.scheduledDate,
          dueDate,
          currency: template.currency,
          fxRate: template.fxRate,
          memo: template.memo,
          terms: template.terms,
          lines: {
            create: template.lines.map((line) => ({
              lineNumber: line.lineNumber,
              itemId: line.itemId,
              description: line.description,
              quantity: line.quantity,
              rate: line.rate,
              // Recalculated on issue; stored so a draft reads correctly.
              amount: line.quantity.times(line.rate).toDecimalPlaces(2),
              incomeAccountId: line.incomeAccountId,
              taxRateId: line.taxRateId,
            })),
          },
        },
      });

      // Totals on the draft itself, so a month of generated retainers does not
      // read as a column of zeroes before anyone opens them. Safe on a draft:
      // recalculateTotals leaves DRAFT status alone.
      await recalculateTotals(invoice.id, tx);

      await tx.recurringInvoiceRun.update({
        where: { id: run.id },
        data: { invoiceId: invoice.id },
      });

      const nextRunDate = occurrenceAfter(template, options.scheduledDate);
      await tx.recurringInvoiceTemplate.update({
        where: { id: template.id },
        data: {
          lastRunDate: options.scheduledDate,
          nextRunDate,
          occurrenceCount: { increment: 1 },
        },
      });

      return {
        templateId: template.id,
        scheduledDate,
        invoiceId: invoice.id,
        status: "CREATED" as const,
      };
    })
    .catch((error: unknown) => {
      // The unique constraint is the idempotency guarantee, so losing that
      // race is a normal outcome and not an error.
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "P2002"
      ) {
        return {
          templateId: options.templateId,
          scheduledDate,
          status: "ALREADY_RUN" as const,
        };
      }
      throw error;
    });

  // Issuing posts to the ledger, so it happens outside the claim transaction
  // through the same service every other invoice goes through — no second way
  // to post revenue (SPEC §4.2).
  if (outcome.status === "CREATED" && outcome.invoiceId) {
    const template = await prisma.recurringInvoiceTemplate.findUniqueOrThrow({
      where: { id: options.templateId },
      select: { mode: true, companyId: true },
    });
    if (template.mode === "AUTO_SEND") {
      try {
        const { invoice } = await issueInvoice({
          companyId: template.companyId,
          invoiceId: outcome.invoiceId,
          role: "OWNER",
        });
        return {
          ...outcome,
          status: "ISSUED",
          invoiceNumber: invoice.invoiceNumber,
        };
      } catch (error) {
        // A template that cannot be issued leaves its draft behind rather than
        // vanishing: the invoice exists and a person can fix it.
        return {
          ...outcome,
          status: "CREATED",
          reason:
            error instanceof PostingError
              ? error.message
              : "Could not issue automatically",
        };
      }
    }
  }

  return outcome;
}

/**
 * Every occurrence a template owes up to and including `throughDate`.
 *
 * A template that has not run for months catches up one invoice per period
 * rather than collapsing them into one — each period genuinely happened.
 */
export function dueOccurrences(
  template: Schedule & { nextRunDate: Date; endDate?: Date | null },
  throughDate: Date,
  cap = 60,
): Date[] {
  const dates: Date[] = [];
  let cursor = occurrenceOnOrAfter(template, template.nextRunDate);
  while (cursor <= throughDate && dates.length < cap) {
    if (template.endDate && cursor > template.endDate) break;
    dates.push(cursor);
    cursor = occurrenceAfter(template, cursor);
  }
  return dates;
}

/** The daily job (SPEC §7.2). Safe to run repeatedly. */
export async function runRecurringInvoices(
  now: Date = new Date(),
): Promise<GenerationResult[]> {
  const companies = await prisma.company.findMany({
    select: { id: true, operatingTimeZone: true },
  });
  const results: GenerationResult[] = [];

  for (const company of companies) {
    // Nothing before 06:00 in the company's own zone, so a template dated
    // today is not generated at one minute past midnight.
    if (operatingHour(now, company.operatingTimeZone) < 6) continue;
    const asOf = operatingToday(now, company.operatingTimeZone);

    const templates = await prisma.recurringInvoiceTemplate.findMany({
      where: {
        companyId: company.id,
        isPaused: false,
        nextRunDate: { lte: asOf },
      },
    });

    for (const template of templates) {
      for (const scheduledDate of dueOccurrences(template, asOf)) {
        results.push(
          await generateOccurrence({ templateId: template.id, scheduledDate }),
        );
      }
    }
  }

  return results;
}

/** The next 30 days of scheduled invoices, for the upcoming list (SPEC §7.2). */
export async function upcomingOccurrences(options: {
  companyId: string;
  from: Date;
  days?: number;
}) {
  const through = new Date(
    options.from.getTime() + (options.days ?? 30) * 86_400_000,
  );
  const templates = await prisma.recurringInvoiceTemplate.findMany({
    where: { companyId: options.companyId, isPaused: false },
    include: { customer: { select: { name: true } }, lines: true },
    orderBy: { nextRunDate: "asc" },
  });

  return templates
    .flatMap((template) => {
      const total = template.lines.reduce(
        (running, line) => running.plus(line.quantity.times(line.rate)),
        template.lines[0]?.quantity.times(0) ?? null,
      );
      return dueOccurrences(template, through).map((date) => ({
        templateId: template.id,
        templateName: template.name,
        customerName: template.customer.name,
        date,
        currency: template.currency,
        mode: template.mode,
        total,
      }));
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}
