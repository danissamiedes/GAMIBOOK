import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { issueInvoice, voidInvoice, deleteDraftInvoice } from "@/lib/invoices/service";
import { recordPayment, reversePayment } from "@/lib/invoices/payments";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { trialBalance, accountBalance } from "@/lib/ledger/reports";
import { money } from "@/lib/money";
import {
  makeCompanyWithChart,
  makeCustomer,
  makeDraftInvoice,
  prisma,
  resetDatabase,
} from "./helpers";

/** SPEC §4.3 receivables side, and the §7.1 status machine. */
describe("invoices in base currency", () => {
  let fixture: Awaited<ReturnType<typeof makeCompanyWithChart>>;
  let customer: Awaited<ReturnType<typeof makeCustomer>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Invoice Co", "PHP");
    customer = await makeCustomer(fixture.company.id, { name: "Acme Corp", currency: "PHP" });
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const draft = () =>
    makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      lines: [
        { description: "Consulting", quantity: "10", rate: "5000.00", incomeAccountId: fixture.code("4000").id },
      ],
    });

  it("posts DR A/R and CR income when issued, and only then", async () => {
    const invoice = await draft();

    // A draft posts nothing.
    expect(await prisma.journalEntry.count({ where: { companyId: fixture.company.id } })).toBe(0);
    expect(invoice.invoiceNumber).toBeNull();

    const { invoice: issued, entry } = await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
    });

    expect(issued.status).toBe("ISSUED");
    expect(issued.invoiceNumber).toBe("INV1001");
    expect(money(issued.total).toFixed(2)).toBe("50000.00");

    const ar = entry.lines.find((line) => line.accountId === fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE).id);
    const income = entry.lines.find((line) => line.accountId === fixture.code("4000").id);
    expect(ar?.debit.toFixed(2)).toBe("50000.00");
    expect(ar?.customerId).toBe(customer.id);
    expect(income?.credit.toFixed(2)).toBe("50000.00");
  });

  it("allocates numbers gap-free and only on issue", async () => {
    const first = await draft();
    const thrown = await draft();
    const second = await draft();

    await issueInvoice({ companyId: fixture.company.id, invoiceId: first.id });
    await deleteDraftInvoice(fixture.company.id, thrown.id);
    const { invoice } = await issueInvoice({ companyId: fixture.company.id, invoiceId: second.id });

    // The discarded draft never consumed a number.
    expect(invoice.invoiceNumber).toBe("INV1002");
  });

  it("goes straight from ISSUED to PAID on a single full payment", async () => {
    const invoice = await draft();
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });

    await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: new Date(Date.UTC(2026, 3, 1)),
      amount: "50000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "50000.00" }],
    });

    const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(paid.status).toBe("PAID");
    expect(money(paid.balanceDue).toFixed(2)).toBe("0.00");

    // A/R is back to zero and the bank holds the cash.
    const ar = await accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE).id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });
    expect(ar.toFixed(2)).toBe("0.00");
  });

  it("moves through PARTIALLY_PAID and back when the payment is reversed", async () => {
    const invoice = await draft();
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });

    const { payment } = await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: new Date(Date.UTC(2026, 3, 1)),
      amount: "20000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "20000.00" }],
    });

    let current = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(current.status).toBe("PARTIALLY_PAID");
    expect(money(current.balanceDue).toFixed(2)).toBe("30000.00");

    await reversePayment({
      companyId: fixture.company.id,
      paymentId: payment.id,
      date: new Date(Date.UTC(2026, 3, 15)),
    });

    current = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(current.status).toBe("ISSUED");
    expect(money(current.balanceDue).toFixed(2)).toBe("50000.00");

    // Nothing was deleted: the payment and both entries are still there.
    const reversed = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reversed.reversedAt).not.toBeNull();
    expect(await prisma.journalEntry.count({ where: { sourceType: "INVOICE_PAYMENT" } })).toBe(2);
  });

  it("settles several invoices with one payment", async () => {
    const first = await draft();
    const second = await draft();
    await issueInvoice({ companyId: fixture.company.id, invoiceId: first.id });
    await issueInvoice({ companyId: fixture.company.id, invoiceId: second.id });

    await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: new Date(Date.UTC(2026, 3, 1)),
      amount: "80000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [
        { invoiceId: first.id, amountApplied: "50000.00" },
        { invoiceId: second.id, amountApplied: "30000.00" },
      ],
    });

    const [a, b] = await Promise.all([
      prisma.invoice.findUniqueOrThrow({ where: { id: first.id } }),
      prisma.invoice.findUniqueOrThrow({ where: { id: second.id } }),
    ]);
    expect(a.status).toBe("PAID");
    expect(b.status).toBe("PARTIALLY_PAID");
    expect(money(b.balanceDue).toFixed(2)).toBe("20000.00");
  });

  it("keeps an over-payment as a credit on account rather than discarding it", async () => {
    const invoice = await draft();
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });

    const { entry } = await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: new Date(Date.UTC(2026, 3, 1)),
      amount: "60000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "50000.00" }],
    });

    const unapplied = entry.lines.find((line) => line.description?.includes("Unapplied"));
    expect(unapplied?.credit.toFixed(2)).toBe("10000.00");

    // A/R now carries a 10,000 credit for this customer — money owed back.
    const ar = await accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE).id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });
    expect(ar.toFixed(2)).toBe("-10000.00");
  });

  it("refuses to apply more than an invoice's balance", async () => {
    const invoice = await draft();
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });

    await expect(
      recordPayment({
        companyId: fixture.company.id,
        customerId: customer.id,
        date: new Date(Date.UTC(2026, 3, 1)),
        amount: "60000.00",
        currency: "PHP",
        depositAccountId: fixture.code("1000").id,
        applications: [{ invoiceId: invoice.id, amountApplied: "60000.00" }],
      }),
    ).rejects.toThrow(/exceeds its balance/);
  });

  it("voids with a full reversal, and refuses to void once paid", async () => {
    const invoice = await draft();
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });

    const { payment } = await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: new Date(Date.UTC(2026, 3, 1)),
      amount: "10000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "10000.00" }],
    });

    await expect(
      voidInvoice({
        companyId: fixture.company.id,
        invoiceId: invoice.id,
        date: new Date(Date.UTC(2026, 3, 20)),
      }),
    ).rejects.toThrow(/Reverse them before voiding/);

    await reversePayment({
      companyId: fixture.company.id,
      paymentId: payment.id,
      date: new Date(Date.UTC(2026, 3, 20)),
    });
    const voided = await voidInvoice({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
      date: new Date(Date.UTC(2026, 3, 20)),
    });

    expect(voided.status).toBe("VOID");
    // The number stays reserved.
    expect(voided.invoiceNumber).toBe("INV1001");

    // Everything nets out and the books still balance.
    const ar = await accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE).id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });
    expect(ar.toFixed(2)).toBe("0.00");

    const tb = await trialBalance({
      companyId: fixture.company.id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });
    expect(tb.balanced).toBe(true);
  });

  it("refuses to delete an issued invoice", async () => {
    const invoice = await draft();
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });
    await expect(deleteDraftInvoice(fixture.company.id, invoice.id)).rejects.toThrow(
      /Only a draft can be deleted/,
    );
  });
});

describe("A/R aging (SPEC §12.5)", () => {
  let fixture: Awaited<ReturnType<typeof makeCompanyWithChart>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Aging Co", "PHP");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("buckets by days overdue and ties to the A/R control account", async () => {
    const { arAging } = await import("@/lib/invoices/aging");
    const acme = await makeCustomer(fixture.company.id, { name: "Acme" });
    const beta = await makeCustomer(fixture.company.id, { name: "Beta" });
    const asOf = new Date(Date.UTC(2026, 5, 30));

    const make = async (customerId: string, issue: Date, amount: string) => {
      const invoice = await makeDraftInvoice({
        companyId: fixture.company.id,
        customerId,
        currency: "PHP",
        issueDate: issue,
        lines: [
          { description: "Work", quantity: "1", rate: amount, incomeAccountId: fixture.code("4000").id },
        ],
      });
      await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });
      return invoice;
    };

    // Due 30 days after issue: these land in current, 1–30 and 90+.
    await make(acme.id, new Date(Date.UTC(2026, 5, 15)), "10000.00");
    await make(acme.id, new Date(Date.UTC(2026, 4, 15)), "5000.00");
    await make(beta.id, new Date(Date.UTC(2026, 1, 1)), "2500.00");

    const report = await arAging({ companyId: fixture.company.id, asOf });

    expect(report.rows.map((row) => row.customerName)).toEqual(["Acme", "Beta"]);
    const acmeRow = report.rows[0];
    expect(acmeRow.current.toFixed(2)).toBe("10000.00");
    expect(acmeRow.days1to30.toFixed(2)).toBe("5000.00");
    expect(report.rows[1].days90plus.toFixed(2)).toBe("2500.00");

    expect(report.totals.total.toFixed(2)).toBe("17500.00");
    expect(report.controlBalance.toFixed(2)).toBe("17500.00");
    expect(report.tiesToLedger).toBe(true);
  });

  it("drops an invoice out of the aging as it is paid", async () => {
    const { arAging } = await import("@/lib/invoices/aging");
    const customer = await makeCustomer(fixture.company.id, { name: "Payer" });
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: new Date(Date.UTC(2026, 5, 1)),
      lines: [
        { description: "Work", quantity: "1", rate: "8000.00", incomeAccountId: fixture.code("4000").id },
      ],
    });
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });

    await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: new Date(Date.UTC(2026, 5, 10)),
      amount: "3000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "3000.00" }],
    });

    const partly = await arAging({ companyId: fixture.company.id, asOf: new Date(Date.UTC(2026, 5, 30)) });
    expect(partly.totals.total.toFixed(2)).toBe("5000.00");
    expect(partly.tiesToLedger).toBe(true);

    await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: new Date(Date.UTC(2026, 5, 20)),
      amount: "5000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "5000.00" }],
    });

    const settled = await arAging({ companyId: fixture.company.id, asOf: new Date(Date.UTC(2026, 5, 30)) });
    expect(settled.rows).toHaveLength(0);
    expect(settled.controlBalance.toFixed(2)).toBe("0.00");
  });
});
