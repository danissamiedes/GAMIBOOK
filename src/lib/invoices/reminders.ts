import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { prepareInvoiceEmail, sendEmail } from "@/lib/email/send";
import { money } from "@/lib/money";

/**
 * Chasing overdue invoices (SPEC §10.2).
 *
 * The `INVOICE_REMINDER` template already existed and nothing ever sent it.
 * This is the thing that sends it: weekly, from a week past due, until the
 * invoice is settled.
 *
 * Four rules, and each is a way this could go wrong:
 *
 *   1. **Off unless switched on.** `invoiceRemindersEnabled` is false on every
 *      company until someone turns it on. The first thing anyone learns about a
 *      misconfigured reminder should not be a customer receiving one.
 *   2. **Weekly, counted from the last reminder** — not from the due date, so a
 *      company that switches this on with a year of old invoices sends one
 *      round, not fifty-two.
 *   3. **A stamp of its own.** `lastRemindedAt` is separate from
 *      `lastEmailedAt`, which means the invoice itself going out. Sharing one
 *      field would make issuing an invoice look like chasing it.
 *   4. **Settled means silence.** Paid, void, nothing owing, no address, or the
 *      customer opted out — each stops it, checked in the query rather than
 *      after composing an email nobody should get.
 *
 * There is no cap on how many reminders one invoice can draw, which is what
 * "weekly until paid" means. Voiding an invoice is the way to stop chasing
 * something that will never be paid.
 */

/** How long past due before the first reminder, and between reminders after it. */
export const REMINDER_INTERVAL_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Invoices due a reminder right now.
 *
 * Exported because the screen that shows "who is being chased" and the job that
 * does the chasing must not be able to disagree.
 */
export async function invoicesDueForReminder(options: { companyId: string; now?: Date }) {
  const now = options.now ?? new Date();
  const firstDue = new Date(now.getTime() - REMINDER_INTERVAL_DAYS * DAY_MS);

  return prisma.invoice.findMany({
    where: {
      companyId: options.companyId,
      status: { in: ["ISSUED", "PARTIALLY_PAID"] },
      balanceDue: { gt: 0 },
      // Overdue by at least the interval. dueDate is a date, so this compares
      // whole days rather than the hour the job happened to run.
      dueDate: { lt: firstDue },
      customer: { sendEmails: true, isActive: true },
      OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lt: firstDue } }],
    },
    include: { customer: true },
    orderBy: { dueDate: "asc" },
    // A company switching this on for the first time sends a round, not a
    // flood: the rest come on the next run an hour later.
    take: 50,
  });
}

export type ReminderResult = {
  sent: { invoiceId: string; number: string | null; customer: string }[];
  failed: { invoiceId: string; number: string | null; reason: string }[];
  skipped: { invoiceId: string; number: string | null; reason: string }[];
};

/** Chase one company's overdue invoices. */
export async function remindCompany(options: {
  companyId: string;
  now?: Date;
}): Promise<ReminderResult> {
  const result: ReminderResult = { sent: [], failed: [], skipped: [] };
  const invoices = await invoicesDueForReminder(options);

  for (const invoice of invoices) {
    const label = { invoiceId: invoice.id, number: invoice.invoiceNumber };

    if (invoice.customer.emails.length === 0) {
      result.skipped.push({ ...label, reason: `${invoice.customer.name} has no email address` });
      continue;
    }

    try {
      const email = await prepareInvoiceEmail({
        companyId: options.companyId,
        invoiceId: invoice.id,
        kind: "INVOICE_REMINDER",
      });
      const sent = await sendEmail({ companyId: options.companyId, email });

      if (sent.status === "SENT") {
        // Stamped only on a real send, so a failure is retried next week
        // rather than counted as a chase that happened.
        await prisma.invoice.updateMany({
          where: { id: invoice.id, companyId: options.companyId },
          data: { lastRemindedAt: options.now ?? new Date() },
        });
        result.sent.push({ ...label, customer: invoice.customer.name });
      } else {
        result.failed.push({ ...label, reason: sent.error ?? "Send failed" });
      }
    } catch (error) {
      result.failed.push({
        ...label,
        reason: error instanceof Error ? error.message : "Could not be prepared",
      });
    }
  }

  if (result.sent.length > 0 || result.failed.length > 0) {
    await writeAudit({
      companyId: options.companyId,
      action: "invoice.reminders_sent",
      entityType: "Invoice",
      entityId: result.sent[0]?.invoiceId ?? null,
      summary: `${result.sent.length} reminder(s) sent${
        result.failed.length ? `, ${result.failed.length} failed` : ""
      }`,
      data: { sent: result.sent, failed: result.failed, skipped: result.skipped },
    });
  }

  return result;
}

/** The scheduled job: every company that has switched reminders on. */
export async function runInvoiceReminders(now = new Date()) {
  const companies = await prisma.company.findMany({
    where: { invoiceRemindersEnabled: true },
    select: { id: true, name: true },
  });

  const runs = [];
  for (const company of companies) {
    // Sequential, and one company's failure does not stop the next: they share
    // nothing but the schedule.
    try {
      const result = await remindCompany({ companyId: company.id, now });
      runs.push({ company: company.name, ...result });
    } catch (error) {
      runs.push({
        company: company.name,
        sent: [],
        failed: [{ invoiceId: "", number: null, reason: String(error) }],
        skipped: [],
      });
    }
  }
  return runs;
}

/** What the settings screen shows before anyone switches this on. */
export async function reminderPreview(companyId: string, now = new Date()) {
  const due = await invoicesDueForReminder({ companyId, now });
  return {
    count: due.length,
    total: due.reduce((sum, invoice) => sum.plus(money(invoice.balanceDue)), money(0)),
    invoices: due.slice(0, 10).map((invoice) => ({
      id: invoice.id,
      number: invoice.invoiceNumber,
      customer: invoice.customer.name,
      dueDate: invoice.dueDate,
      balanceDue: invoice.balanceDue,
      reachable: invoice.customer.emails.length > 0,
    })),
  };
}
