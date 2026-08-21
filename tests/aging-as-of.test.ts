import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { issueInvoice, voidInvoice } from "@/lib/invoices/service";
import { recordPayment, reversePayment } from "@/lib/invoices/payments";
import { approveWorkOrder } from "@/lib/payables/work-orders";
import { recordBillPayment } from "@/lib/payables/bill-payments";
import { arAging } from "@/lib/invoices/aging";
import { apAging } from "@/lib/payables/aging";
import {
  makeCompanyWithChart,
  makeCustomer,
  makeDraftInvoice,
  makeVendor,
  prisma,
  resetDatabase,
} from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const at = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day));

/**
 * Aging as at a *past* date.
 *
 * Both reports used to read each document's current balance, so a document
 * settled in August looked settled in July too — the report answered "what is
 * open now" whatever date you asked for, and disagreed with the ledger for
 * every closed period. The tie-out against the control account at the same
 * past date is the assertion that matters: it is the thing an accountant does
 * at year end.
 */
describe("aging as at a past date", () => {
  let fixture: Fixture;

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("As Of Co", "PHP");
  });

  it("shows a receivable that was open then and settled since — and ties to the ledger both times", async () => {
    const customer = await makeCustomer(fixture.company.id, {
      name: "Cebu Retail",
    });
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: at(2026, 6, 1),
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          rate: "40000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
      role: "OWNER",
    });
    await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: at(2026, 8, 10),
      amount: "40000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "40000.00" }],
      role: "OWNER",
    });

    const july = await arAging({
      companyId: fixture.company.id,
      asOf: at(2026, 7, 31),
    });
    expect(july.totals.total.toFixed(2)).toBe("40000.00");
    expect(july.tiesToLedger).toBe(true);

    const september = await arAging({
      companyId: fixture.company.id,
      asOf: at(2026, 9, 30),
    });
    expect(september.totals.total.toFixed(2)).toBe("0.00");
    expect(september.tiesToLedger).toBe(true);
  });

  it("counts a part payment on the date it landed, not before", async () => {
    const customer = await makeCustomer(fixture.company.id);
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: at(2026, 6, 1),
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          rate: "40000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
      role: "OWNER",
    });
    await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: at(2026, 7, 15),
      amount: "15000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "15000.00" }],
      role: "OWNER",
    });

    const before = await arAging({
      companyId: fixture.company.id,
      asOf: at(2026, 7, 14),
    });
    expect(before.totals.total.toFixed(2)).toBe("40000.00");
    expect(before.tiesToLedger).toBe(true);

    const after = await arAging({
      companyId: fixture.company.id,
      asOf: at(2026, 7, 31),
    });
    expect(after.totals.total.toFixed(2)).toBe("25000.00");
    expect(after.tiesToLedger).toBe(true);
  });

  it("treats a payment reversed later as still in force at the earlier date", async () => {
    const customer = await makeCustomer(fixture.company.id);
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: at(2026, 6, 1),
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          rate: "40000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
      role: "OWNER",
    });
    const { payment } = await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: at(2026, 7, 1),
      amount: "40000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "40000.00" }],
      role: "OWNER",
    });
    // The cheque bounced in September. July's books do not know that yet.
    await reversePayment({
      companyId: fixture.company.id,
      paymentId: payment.id,
      date: at(2026, 9, 5),
      role: "OWNER",
    });

    const july = await arAging({
      companyId: fixture.company.id,
      asOf: at(2026, 7, 31),
    });
    expect(july.totals.total.toFixed(2)).toBe("0.00");
    expect(july.tiesToLedger).toBe(true);

    const september = await arAging({
      companyId: fixture.company.id,
      asOf: at(2026, 9, 30),
    });
    expect(september.totals.total.toFixed(2)).toBe("40000.00");
    expect(september.tiesToLedger).toBe(true);
  });

  it("keeps an invoice voided later on the books at the earlier date", async () => {
    const customer = await makeCustomer(fixture.company.id);
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: at(2026, 6, 1),
      lines: [
        {
          description: "Cancelled work",
          quantity: "1",
          rate: "12000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
      role: "OWNER",
    });
    await voidInvoice({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
      date: at(2026, 8, 20),
      role: "OWNER",
    });

    const july = await arAging({
      companyId: fixture.company.id,
      asOf: at(2026, 7, 31),
    });
    expect(july.totals.total.toFixed(2)).toBe("12000.00");
    expect(july.tiesToLedger).toBe(true);

    const september = await arAging({
      companyId: fixture.company.id,
      asOf: at(2026, 9, 30),
    });
    expect(september.totals.total.toFixed(2)).toBe("0.00");
    expect(september.tiesToLedger).toBe(true);
  });

  it("does the same on the payables side, per vendor as well as in total", async () => {
    const consultant = await makeVendor(fixture.company.id, "CONSULTANT", {
      name: "Abigail",
    });
    const workOrder = await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: consultant.id,
        issueDate: at(2026, 6, 1),
        dueDate: at(2026, 6, 30),
        currency: "PHP",
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "Fieldwork",
              quantity: "1",
              rate: "18000.00",
              amount: "18000.00",
              accountId: fixture.code("6000").id,
            },
          ],
        },
      },
    });
    await approveWorkOrder({
      companyId: fixture.company.id,
      workOrderId: workOrder.id,
      role: "OWNER",
    });
    await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: consultant.id,
      date: at(2026, 8, 12),
      amount: "18000.00",
      currency: "PHP",
      paymentAccountId: fixture.code("1000").id,
      applications: [{ workOrderId: workOrder.id, amountApplied: "18000.00" }],
      role: "OWNER",
    });

    const july = await apAging({
      companyId: fixture.company.id,
      asOf: at(2026, 7, 31),
    });
    expect(july.totals.total.toFixed(2)).toBe("18000.00");
    expect(july.controlBalance.toFixed(2)).toBe("18000.00");
    expect(july.tiesToLedger).toBe(true);
    expect(july.mismatchedVendors).toEqual([]);

    const september = await apAging({
      companyId: fixture.company.id,
      asOf: at(2026, 9, 30),
    });
    expect(september.totals.total.toFixed(2)).toBe("0.00");
    expect(september.tiesToLedger).toBe(true);
    expect(september.mismatchedVendors).toEqual([]);
  });

  it("leaves a work order approved later out of an earlier date", async () => {
    // Approval is what makes it a payable, and it is dated in its own right
    // (SPEC §8.1) — the issue date is not what the ledger went by.
    const consultant = await makeVendor(fixture.company.id, "CONSULTANT");
    const workOrder = await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: consultant.id,
        issueDate: at(2026, 6, 1),
        dueDate: at(2026, 6, 30),
        currency: "PHP",
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "Fieldwork",
              quantity: "1",
              rate: "9000.00",
              amount: "9000.00",
              accountId: fixture.code("6000").id,
            },
          ],
        },
      },
    });
    await approveWorkOrder({
      companyId: fixture.company.id,
      workOrderId: workOrder.id,
      approvedAt: at(2026, 8, 1),
      role: "OWNER",
    });

    const july = await apAging({
      companyId: fixture.company.id,
      asOf: at(2026, 7, 31),
    });
    expect(july.totals.total.toFixed(2)).toBe("0.00");
    expect(july.tiesToLedger).toBe(true);

    const august = await apAging({
      companyId: fixture.company.id,
      asOf: at(2026, 8, 31),
    });
    expect(august.totals.total.toFixed(2)).toBe("9000.00");
    expect(august.tiesToLedger).toBe(true);
  });
});
