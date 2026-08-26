import type { ExpenseKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { isoDate } from "@/lib/dates";
import { money } from "@/lib/money";
import {
  dueOccurrences,
  occurrenceAfter,
  occurrenceOnOrAfter,
  operatingHour,
  operatingToday,
} from "@/lib/invoices/recurring";
import { recordExpense } from "./expenses";

/**
 * Recurring bills and direct expenses (SPEC §8.2a) — rent, a retainer, a
 * utility. The payables mirror of recurring invoices, and deliberately built on
 * the same two foundations:
 *
 * The schedule arithmetic is imported wholesale from `invoices/recurring`, not
 * copied. That is where this kind of feature usually goes wrong — "the 31st" in
 * February, a fortnight that must keep its own cadence rather than drifting to
 * the nearest month — and having one implementation means one place to be right
 * and one set of tests proving it.
 *
 * Idempotency is the (templateId, scheduledDate) unique row, claimed before
 * anything else happens. Not a check-then-write: this deployment runs two
 * schedulers on purpose (see DECISIONS, "Two schedulers, deliberately"), so two
 * overlapping runs are the expected case, and both would pass a check.
 *
 * One difference from the invoice side, and it is the reason this feature is
 * worth having: a recurring invoice produces a **draft**, because auto-sending
 * a document to a customer is consequential. A bill goes to nobody. It records
 * straight away and posts, which is what makes A/P Aging true on the first of
 * the month without anyone remembering to type the rent in.
 */

export type BillGenerationResult = {
  templateId: string;
  templateName: string;
  scheduledDate: string;
  expenseId?: string;
  status: "RECORDED" | "SKIPPED" | "ALREADY_RUN";
  reason?: string;
};

/** What a template needs before it can record anything. Null when it is fine. */
export function whyTemplateCannotRun(template: {
  kind: ExpenseKind;
  vendorId: string | null;
  paymentAccountId: string | null;
  amount: Prisma.Decimal;
}): string | null {
  if (money(template.amount).lessThanOrEqualTo(0)) {
    return "The amount must be more than zero";
  }
  // recordExpense refuses both of these too. Saying so here means the screen
  // can show it beside the template instead of it surfacing as a failed run
  // at six in the morning.
  if (template.kind === "BILL" && !template.vendorId) {
    return "A bill needs a vendor — that is who you owe";
  }
  if (template.kind === "DIRECT" && !template.paymentAccountId) {
    return "A direct expense needs an account to be paid from";
  }
  return null;
}

/**
 * Record what a template owes for one scheduled date.
 *
 * Two steps, in this order and not the other: claim the slot and advance the
 * schedule in one transaction, then post outside it. `recordExpense` opens its
 * own transaction — it is the single posting path and stays that way (SPEC
 * §4.2 rule 5) — so it cannot be nested inside the claim.
 *
 * The consequence is that a post which fails after a successful claim leaves a
 * run row with a reason and no expense, and the schedule already moved on. That
 * is the right trade: the alternative is retrying a bill that cannot post every
 * hour forever, and the reason is on the screen where someone will see it.
 */
export async function generateBillOccurrence(options: {
  templateId: string;
  scheduledDate: Date;
}): Promise<BillGenerationResult> {
  // ISO: this is an identifier beside the (templateId, scheduledDate) unique
  // row, not something a person reads.
  const scheduledDate = isoDate(options.scheduledDate);

  const claim = await prisma
    .$transaction(async (tx) => {
      const template = await tx.recurringBillTemplate.findUniqueOrThrow({
        where: { id: options.templateId },
      });

      // Claim the slot first: if this throws on the unique constraint, nothing
      // else in the transaction has happened.
      const run = await tx.recurringBillRun.create({
        data: { templateId: template.id, scheduledDate: options.scheduledDate },
      });

      const stop = async (reason: string) => {
        await tx.recurringBillRun.update({ where: { id: run.id }, data: { skippedReason: reason } });
        return {
          templateId: template.id,
          templateName: template.name,
          scheduledDate,
          status: "SKIPPED" as const,
          reason,
        };
      };

      if (template.endDate && options.scheduledDate > template.endDate) {
        return stop("Past the template's end date");
      }
      if (
        template.occurrenceLimit !== null &&
        template.occurrenceCount >= template.occurrenceLimit
      ) {
        return stop("Occurrence limit reached");
      }
      const unusable = whyTemplateCannotRun(template);
      if (unusable) return stop(unusable);

      // Advanced here, inside the claim, so a crash between the two steps
      // cannot leave the template due for the same date again.
      await tx.recurringBillTemplate.update({
        where: { id: template.id },
        data: {
          lastRunDate: options.scheduledDate,
          nextRunDate: occurrenceAfter(template, options.scheduledDate),
          occurrenceCount: { increment: 1 },
        },
      });

      return {
        templateId: template.id,
        templateName: template.name,
        scheduledDate,
        status: "CLAIMED" as const,
        runId: run.id,
        template,
      };
    })
    .catch((error: unknown) => {
      // The unique constraint is the idempotency guarantee, so losing that
      // race is a normal outcome, not an error.
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "P2002"
      ) {
        return {
          templateId: options.templateId,
          templateName: "",
          scheduledDate,
          status: "ALREADY_RUN" as const,
        };
      }
      throw error;
    });

  if (claim.status !== "CLAIMED") return claim;

  const { template, runId } = claim;
  try {
    const { expense } = await recordExpense({
      companyId: template.companyId,
      kind: template.kind,
      vendorId: template.vendorId,
      date: options.scheduledDate,
      currency: template.currency,
      fxRate: template.fxRate,
      amount: template.amount,
      expenseAccountId: template.expenseAccountId,
      paymentAccountId: template.kind === "DIRECT" ? template.paymentAccountId : null,
      dueDate:
        template.kind === "BILL"
          ? new Date(options.scheduledDate.getTime() + template.paymentTermsDays * 86_400_000)
          : null,
      description: template.description,
      reference: template.reference,
      // No userId: the scheduler is not a person, so nothing is recorded as
      // the author. Delete is gated on the period rather than on authorship,
      // so a wrong template's output can still be cleared up while the month
      // is open.
      userId: null,
      role: null,
    });

    await prisma.recurringBillRun.update({
      where: { id: runId },
      data: { expenseId: expense.id },
    });

    return {
      templateId: template.id,
      templateName: template.name,
      scheduledDate,
      expenseId: expense.id,
      status: "RECORDED" as const,
    };
  } catch (error) {
    const reason =
      error instanceof PostingError ? error.message : "Could not record this occurrence";
    await prisma.recurringBillRun.update({ where: { id: runId }, data: { skippedReason: reason } });
    return {
      templateId: template.id,
      templateName: template.name,
      scheduledDate,
      status: "SKIPPED" as const,
      reason,
    };
  }
}

/** The daily job. Safe to run repeatedly, and expected to be. */
export async function runRecurringBills(now: Date = new Date()): Promise<BillGenerationResult[]> {
  const companies = await prisma.company.findMany({
    select: { id: true, operatingTimeZone: true },
  });
  const results: BillGenerationResult[] = [];

  for (const company of companies) {
    // Nothing before 06:00 in the company's own zone, matching the invoice
    // job: a template dated today should not fire at one minute past midnight.
    if (operatingHour(now, company.operatingTimeZone) < 6) continue;
    const asOf = operatingToday(now, company.operatingTimeZone);

    const templates = await prisma.recurringBillTemplate.findMany({
      where: { companyId: company.id, isPaused: false, nextRunDate: { lte: asOf } },
    });

    for (const template of templates) {
      // A template that has not run for months catches up one bill per period
      // rather than collapsing them into one — each month's rent was genuinely
      // owed.
      for (const scheduledDate of dueOccurrences(template, asOf)) {
        results.push(
          await generateBillOccurrence({ templateId: template.id, scheduledDate }),
        );
      }
    }
  }

  return results;
}

/** The next 30 days of scheduled bills, for the upcoming list. */
export async function upcomingBills(options: {
  companyId: string;
  from: Date;
  days?: number;
}) {
  const through = new Date(options.from.getTime() + (options.days ?? 30) * 86_400_000);
  const templates = await prisma.recurringBillTemplate.findMany({
    where: { companyId: options.companyId, isPaused: false },
    include: { vendor: { select: { name: true } } },
    orderBy: { nextRunDate: "asc" },
  });

  return templates
    .flatMap((template) =>
      dueOccurrences(template, through).map((date) => ({
        templateId: template.id,
        templateName: template.name,
        vendorName: template.vendor?.name ?? null,
        kind: template.kind,
        date,
        currency: template.currency,
        amount: template.amount,
      })),
    )
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * The first run date for a new or edited template.
 *
 * Exported because the form needs it: someone setting up rent that started in
 * January should see the next occurrence, not January, and should not have the
 * scheduler catch up eleven months of rent the moment they press save.
 */
export function firstRunDate(
  schedule: Parameters<typeof occurrenceOnOrAfter>[0],
  from: Date,
): Date {
  return occurrenceOnOrAfter(schedule, from);
}
