import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  REMINDER_INTERVAL_DAYS,
  invoicesDueForReminder,
  remindCompany,
  runInvoiceReminders,
} from "@/lib/invoices/reminders";
import { issueInvoice } from "@/lib/invoices/service";
import { recordPayment } from "@/lib/invoices/payments";
import {
  makeCompanyWithChart,
  makeCustomer,
  makeDraftInvoice,
  prisma,
  resetDatabase,
} from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const DAY = 86_400_000;

/**
 * SPEC §10.2: chasing overdue invoices without being asked.
 *
 * The tests worth having here are about what it does NOT send: an invoice that
 * is paid, one whose customer opted out, one chased three days ago, and
 * anything at all for a company that has not switched this on. An automated
 * email is only as good as the cases where it stays quiet.
 */
describe("overdue invoice reminders", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetDatabase();
    process.env.EMAIL_DRY_RUN = "true";
    fixture = await makeCompanyWithChart("Chasing Co", "PHP");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  /** An issued invoice due on `dueDate`. */
  const overdueInvoice = async (dueDate: Date, customerId?: string) => {
    const customer = customerId ?? (await makeCustomer(fixture.company.id)).id;
    const draft = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer,
      currency: "PHP",
      issueDate: utc(2026, 6, 1),
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          rate: "10000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    await prisma.invoice.update({ where: { id: draft.id }, data: { dueDate } });
    const { invoice } = await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: draft.id,
      role: "OWNER",
    });
    return invoice;
  };

  const enable = () =>
    prisma.company.update({
      where: { id: fixture.company.id },
      data: { invoiceRemindersEnabled: true },
    });

  it("chases an invoice a week past due", async () => {
    const now = utc(2026, 7, 20);
    await overdueInvoice(utc(2026, 7, 1));

    const due = await invoicesDueForReminder({ companyId: fixture.company.id, now });
    expect(due).toHaveLength(1);

    const result = await remindCompany({ companyId: fixture.company.id, now });
    expect(result.sent).toHaveLength(1);
    expect(await prisma.emailLog.count()).toBe(1);
  });

  it("stays quiet until a week has passed", async () => {
    const now = utc(2026, 7, 10);
    // Due three days ago: overdue, but not yet a week.
    await overdueInvoice(new Date(now.getTime() - 3 * DAY));

    expect(await invoicesDueForReminder({ companyId: fixture.company.id, now })).toHaveLength(0);
    expect(REMINDER_INTERVAL_DAYS).toBe(7);
  });

  it("waits another week before chasing the same invoice again", async () => {
    const now = utc(2026, 7, 20);
    await overdueInvoice(utc(2026, 7, 1));
    await remindCompany({ companyId: fixture.company.id, now });

    // Three days later: nothing.
    const soon = new Date(now.getTime() + 3 * DAY);
    expect(await invoicesDueForReminder({ companyId: fixture.company.id, now: soon })).toHaveLength(0);

    // Eight days later: chased again.
    const later = new Date(now.getTime() + 8 * DAY);
    expect(await invoicesDueForReminder({ companyId: fixture.company.id, now: later })).toHaveLength(1);
  });

  it("counts the week from the last reminder, not the due date", async () => {
    // Switching this on with a year-old invoice sends one reminder, not fifty.
    const now = utc(2026, 7, 20);
    await overdueInvoice(utc(2025, 7, 1));

    const first = await remindCompany({ companyId: fixture.company.id, now });
    expect(first.sent).toHaveLength(1);

    const again = await remindCompany({
      companyId: fixture.company.id,
      now: new Date(now.getTime() + DAY),
    });
    expect(again.sent).toHaveLength(0);
  });

  it("stops as soon as the invoice is paid", async () => {
    const now = utc(2026, 7, 20);
    const invoice = await overdueInvoice(utc(2026, 7, 1));

    await recordPayment({
      companyId: fixture.company.id,
      customerId: invoice.customerId,
      date: utc(2026, 7, 19),
      amount: "10000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "10000.00" }],
      role: "OWNER",
    });

    expect(await invoicesDueForReminder({ companyId: fixture.company.id, now })).toHaveLength(0);
  });

  it("chases a part-paid invoice for what is still owing", async () => {
    const now = utc(2026, 7, 20);
    const invoice = await overdueInvoice(utc(2026, 7, 1));

    await recordPayment({
      companyId: fixture.company.id,
      customerId: invoice.customerId,
      date: utc(2026, 7, 19),
      amount: "4000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "4000.00" }],
      role: "OWNER",
    });

    expect(await invoicesDueForReminder({ companyId: fixture.company.id, now })).toHaveLength(1);
  });

  it("leaves a customer who opted out alone", async () => {
    const now = utc(2026, 7, 20);
    const customer = await makeCustomer(fixture.company.id);
    await overdueInvoice(utc(2026, 7, 1), customer.id);
    await prisma.customer.update({ where: { id: customer.id }, data: { sendEmails: false } });

    expect(await invoicesDueForReminder({ companyId: fixture.company.id, now })).toHaveLength(0);
  });

  it("skips a customer with no address rather than failing the run", async () => {
    const now = utc(2026, 7, 20);
    const customer = await makeCustomer(fixture.company.id);
    await prisma.customer.update({ where: { id: customer.id }, data: { emails: [] } });
    await overdueInvoice(utc(2026, 7, 1), customer.id);

    const result = await remindCompany({ companyId: fixture.company.id, now });
    expect(result.sent).toHaveLength(0);
    expect(result.skipped[0].reason).toMatch(/no email address/);
  });

  it("ignores a voided invoice, which is how you stop chasing forever", async () => {
    const now = utc(2026, 7, 20);
    const invoice = await overdueInvoice(utc(2026, 7, 1));
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "VOID" } });

    expect(await invoicesDueForReminder({ companyId: fixture.company.id, now })).toHaveLength(0);
  });

  it("sends nothing at all for a company that has not switched it on", async () => {
    await overdueInvoice(utc(2026, 7, 1));

    const runs = await runInvoiceReminders(utc(2026, 7, 20));
    expect(runs).toHaveLength(0);
    expect(await prisma.emailLog.count()).toBe(0);

    await enable();
    const after = await runInvoiceReminders(utc(2026, 7, 20));
    expect(after).toHaveLength(1);
    expect(after[0].sent).toHaveLength(1);
  });

  it("does not chase another company's invoices", async () => {
    const now = utc(2026, 7, 20);
    await overdueInvoice(utc(2026, 7, 1));
    const elsewhere = await makeCompanyWithChart("Elsewhere", "PHP");

    expect(await invoicesDueForReminder({ companyId: elsewhere.company.id, now })).toHaveLength(0);
  });

  it("records the run in the audit trail", async () => {
    const now = utc(2026, 7, 20);
    await overdueInvoice(utc(2026, 7, 1));
    await remindCompany({ companyId: fixture.company.id, now });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "invoice.reminders_sent" },
    });
    expect(audit.summary).toContain("1 reminder(s) sent");
  });
});
