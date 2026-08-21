import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  approveWorkOrder,
  computeWorkOrderLine,
  deleteDraftWorkOrder,
  voidWorkOrder,
} from "@/lib/payables/work-orders";
import { recordBillPayment, reverseBillPayment } from "@/lib/payables/bill-payments";
import { recordExpense } from "@/lib/payables/expenses";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { accountBalance, trialBalance } from "@/lib/ledger/reports";
import { money } from "@/lib/money";
import { makeCompanyWithChart, makeVendor, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

async function makeWorkOrder(
  fixture: Fixture,
  vendorId: string,
  lines: { description: string; quantity: string; rate: string; code: string }[],
  options: { currency?: string; fxRate?: string; issueDate?: Date } = {},
) {
  const issueDate = options.issueDate ?? new Date(Date.UTC(2026, 7, 15));
  return prisma.workOrder.create({
    data: {
      companyId: fixture.company.id,
      vendorId,
      issueDate,
      dueDate: new Date(issueDate.getTime() + 15 * 86_400_000),
      currency: options.currency ?? "PHP",
      fxRate: options.fxRate ?? "1",
      lines: {
        create: lines.map((line, index) => ({
          lineNumber: index + 1,
          description: line.description,
          quantity: line.quantity,
          rate: line.rate,
          amount: computeWorkOrderLine(line),
          accountId: fixture.code(line.code).id,
        })),
      },
    },
    include: { lines: true },
  });
}

describe("work orders (SPEC §8.1)", () => {
  let fixture: Fixture;
  let consultant: Awaited<ReturnType<typeof makeVendor>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Payables Co", "PHP");
    consultant = await makeVendor(fixture.company.id, "CONSULTANT", { name: "Abigail Bautista" });
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const ap = () =>
    accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE).id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });

  it("posts DR line accounts and CR A/P on approval, not before", async () => {
    const workOrder = await makeWorkOrder(fixture, consultant.id, [
      { description: "Consultation for period 072626-081026", quantity: "0.5", rate: "100000.00", code: "5000" },
    ]);

    expect(await prisma.journalEntry.count({ where: { companyId: fixture.company.id } })).toBe(0);
    expect(workOrder.workOrderNumber).toBeNull();

    const { workOrder: approved, entry } = await approveWorkOrder({
      companyId: fixture.company.id,
      workOrderId: workOrder.id,
    });

    expect(approved.status).toBe("APPROVED");
    expect(approved.workOrderNumber).toBe("WO1001");

    const fees = entry.lines.find((line) => line.accountId === fixture.code("5000").id);
    const payable = entry.lines.find(
      (line) => line.accountId === fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE).id,
    );
    expect(fees?.debit.toFixed(2)).toBe("50000.00");
    expect(payable?.credit.toFixed(2)).toBe("50000.00");
    expect(payable?.vendorId).toBe(consultant.id);
  });

  it("dates the posting from the sheet's work order date, not the approval click", async () => {
    const workOrder = await makeWorkOrder(
      fixture,
      consultant.id,
      [{ description: "August work", quantity: "1", rate: "10000.00", code: "5000" }],
      { issueDate: new Date(Date.UTC(2026, 7, 15)) },
    );

    const { workOrder: approved, entry } = await approveWorkOrder({
      companyId: fixture.company.id,
      workOrderId: workOrder.id,
    });

    expect(approved.approvedAt?.toISOString().slice(0, 10)).toBe("2026-08-15");
    expect(entry.date.toISOString().slice(0, 10)).toBe("2026-08-15");
  });

  it("handles a multi-line order with a negative cash advance line", async () => {
    // The user's real sheet: John Rex has two lines, the second a deduction.
    const workOrder = await makeWorkOrder(fixture, consultant.id, [
      { description: "Consultation for period 072626-081026", quantity: "0.5", rate: "16000.00", code: "5000" },
      { description: "Cash Advances", quantity: "1", rate: "-3000.00", code: "1200" },
    ]);

    const { workOrder: approved, entry } = await approveWorkOrder({
      companyId: fixture.company.id,
      workOrderId: workOrder.id,
    });

    // Net payable is 8,000 − 3,000.
    expect(money(approved.total).toFixed(2)).toBe("5000.00");

    const fees = entry.lines.find((line) => line.accountId === fixture.code("5000").id);
    const advance = entry.lines.find((line) => line.accountId === fixture.code("1200").id);
    const payable = entry.lines.find(
      (line) => line.accountId === fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE).id,
    );

    // Expense stays at its full 8,000; the advance clears as a credit to the
    // asset account; A/P carries only what is actually owed.
    expect(fees?.debit.toFixed(2)).toBe("8000.00");
    expect(advance?.credit.toFixed(2)).toBe("3000.00");
    expect(payable?.credit.toFixed(2)).toBe("5000.00");

    const tb = await trialBalance({
      companyId: fixture.company.id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });
    expect(tb.balanced).toBe(true);
  });

  it("refuses an order whose deductions swallow the work", async () => {
    const workOrder = await makeWorkOrder(fixture, consultant.id, [
      { description: "Work", quantity: "1", rate: "1000.00", code: "5000" },
      { description: "Cash Advances", quantity: "1", rate: "-1500.00", code: "1200" },
    ]);
    await expect(
      approveWorkOrder({ companyId: fixture.company.id, workOrderId: workOrder.id }),
    ).rejects.toThrow(/net to more than zero/);
  });

  it("numbers from WO1001 upward, and a discarded draft takes no number", async () => {
    const first = await makeWorkOrder(fixture, consultant.id, [
      { description: "A", quantity: "1", rate: "100.00", code: "5000" },
    ]);
    const thrown = await makeWorkOrder(fixture, consultant.id, [
      { description: "B", quantity: "1", rate: "100.00", code: "5000" },
    ]);
    const second = await makeWorkOrder(fixture, consultant.id, [
      { description: "C", quantity: "1", rate: "100.00", code: "5000" },
    ]);

    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: first.id });
    await deleteDraftWorkOrder(fixture.company.id, thrown.id);
    const { workOrder } = await approveWorkOrder({
      companyId: fixture.company.id,
      workOrderId: second.id,
    });
    expect(workOrder.workOrderNumber).toBe("WO1002");
  });

  it("pays a work order and clears A/P to zero", async () => {
    const workOrder = await makeWorkOrder(fixture, consultant.id, [
      { description: "Work", quantity: "1", rate: "25000.00", code: "5000" },
    ]);
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: workOrder.id });

    await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: consultant.id,
      date: new Date(Date.UTC(2026, 8, 1)),
      amount: "25000.00",
      currency: "PHP",
      paymentAccountId: fixture.code("1000").id,
      applications: [{ workOrderId: workOrder.id, amountApplied: "25000.00" }],
    });

    const paid = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } });
    expect(paid.status).toBe("PAID");
    expect((await ap()).toFixed(2)).toBe("0.00");
  });

  it("reverses a payment and puts the balance back", async () => {
    const workOrder = await makeWorkOrder(fixture, consultant.id, [
      { description: "Work", quantity: "1", rate: "9000.00", code: "5000" },
    ]);
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: workOrder.id });

    const { payment } = await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: consultant.id,
      date: new Date(Date.UTC(2026, 8, 1)),
      amount: "4000.00",
      currency: "PHP",
      paymentAccountId: fixture.code("1000").id,
      applications: [{ workOrderId: workOrder.id, amountApplied: "4000.00" }],
    });

    expect(
      (await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })).status,
    ).toBe("PARTIALLY_PAID");

    await reverseBillPayment({
      companyId: fixture.company.id,
      billPaymentId: payment.id,
      date: new Date(Date.UTC(2026, 8, 5)),
    });

    const restored = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } });
    expect(restored.status).toBe("APPROVED");
    expect(money(restored.balanceDue).toFixed(2)).toBe("9000.00");
    expect((await ap()).toFixed(2)).toBe("9000.00");
  });

  it("blocks voiding a work order that has been paid", async () => {
    const workOrder = await makeWorkOrder(fixture, consultant.id, [
      { description: "Work", quantity: "1", rate: "5000.00", code: "5000" },
    ]);
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: workOrder.id });
    await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: consultant.id,
      date: new Date(Date.UTC(2026, 8, 1)),
      amount: "5000.00",
      currency: "PHP",
      paymentAccountId: fixture.code("1000").id,
      applications: [{ workOrderId: workOrder.id, amountApplied: "5000.00" }],
    });

    await expect(
      voidWorkOrder({
        companyId: fixture.company.id,
        workOrderId: workOrder.id,
        date: new Date(Date.UTC(2026, 8, 10)),
      }),
    ).rejects.toThrow(/Reverse them first/);
  });

  it("settles several work orders with one payment", async () => {
    const first = await makeWorkOrder(fixture, consultant.id, [
      { description: "A", quantity: "1", rate: "3000.00", code: "5000" },
    ]);
    const second = await makeWorkOrder(fixture, consultant.id, [
      { description: "B", quantity: "1", rate: "7000.00", code: "5000" },
    ]);
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: first.id });
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: second.id });

    await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: consultant.id,
      date: new Date(Date.UTC(2026, 8, 1)),
      amount: "10000.00",
      currency: "PHP",
      paymentAccountId: fixture.code("1000").id,
      applications: [
        { workOrderId: first.id, amountApplied: "3000.00" },
        { workOrderId: second.id, amountApplied: "7000.00" },
      ],
    });

    expect((await ap()).toFixed(2)).toBe("0.00");
  });
});

describe("PHP work order in USD books (SPEC §15.15)", () => {
  let fixture: Fixture;
  let consultant: Awaited<ReturnType<typeof makeVendor>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("US Books", "USD");
    consultant = await makeVendor(fixture.company.id, "CONSULTANT", {
      name: "Manila Consultant",
      currency: "PHP",
    });
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const ap = () =>
    accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE).id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });

  it("converts at the document rate, then books FX on settlement", async () => {
    // PHP 100,000 at 0.0172 USD per peso is USD 1,720.
    const workOrder = await makeWorkOrder(
      fixture,
      consultant.id,
      [{ description: "Consultation", quantity: "1", rate: "100000.00", code: "5000" }],
      { currency: "PHP", fxRate: "0.0172" },
    );
    const { workOrder: approved } = await approveWorkOrder({
      companyId: fixture.company.id,
      workOrderId: workOrder.id,
    });
    expect(money(approved.baseTotal).toFixed(2)).toBe("1720.00");
    expect((await ap()).toFixed(2)).toBe("1720.00");

    // Paid when the peso is stronger: the same PHP costs more dollars.
    const { entry } = await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: consultant.id,
      date: new Date(Date.UTC(2026, 8, 5)),
      amount: "100000.00",
      currency: "PHP",
      fxRate: "0.0178",
      paymentAccountId: fixture.code("1000").id,
      applications: [{ workOrderId: workOrder.id, amountApplied: "100000.00" }],
    });

    const payable = entry.lines.find(
      (line) => line.accountId === fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE).id,
    );
    const bank = entry.lines.find((line) => line.accountId === fixture.code("1000").id);
    const fx = entry.lines.find(
      (line) => line.accountId === fixture.system(SYSTEM_ACCOUNTS.REALIZED_FX_GAIN_LOSS).id,
    );

    expect(payable?.debit.toFixed(2)).toBe("1720.00"); // the document's rate
    expect(bank?.credit.toFixed(2)).toBe("1780.00"); // the payment's rate
    expect(fx?.debit.toFixed(2)).toBe("60.00"); // settling cost 60 more: a loss

    // The control account lands exactly on zero for this document.
    expect((await ap()).toFixed(2)).toBe("0.00");
  });

  it("relieves A/P pro rata at the document rate on a partial payment", async () => {
    const workOrder = await makeWorkOrder(
      fixture,
      consultant.id,
      [{ description: "Consultation", quantity: "1", rate: "90000.00", code: "5000" }],
      { currency: "PHP", fxRate: "0.0172" },
    );
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: workOrder.id });

    // A third of it, at a different rate.
    const { entry } = await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: consultant.id,
      date: new Date(Date.UTC(2026, 8, 5)),
      amount: "30000.00",
      currency: "PHP",
      fxRate: "0.0180",
      paymentAccountId: fixture.code("1000").id,
      applications: [{ workOrderId: workOrder.id, amountApplied: "30000.00" }],
    });

    const payable = entry.lines.find(
      (line) => line.accountId === fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE).id,
    );
    // 1,548.00 × 30,000/90,000 = 516.00 at the document's rate.
    expect(payable?.debit.toFixed(2)).toBe("516.00");
    expect((await ap()).toFixed(2)).toBe("1032.00");

    // The rest, at yet another rate, clears the document exactly.
    await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: consultant.id,
      date: new Date(Date.UTC(2026, 9, 5)),
      amount: "60000.00",
      currency: "PHP",
      fxRate: "0.0169",
      paymentAccountId: fixture.code("1000").id,
      applications: [{ workOrderId: workOrder.id, amountApplied: "60000.00" }],
    });
    expect((await ap()).toFixed(2)).toBe("0.00");
  });

  it("posts the line-rounding residual rather than distorting an expense line", async () => {
    const workOrder = await makeWorkOrder(
      fixture,
      consultant.id,
      Array.from({ length: 7 }, (_, index) => ({
        description: `Line ${index + 1}`,
        quantity: "1",
        rate: "3333.33",
        code: "5000",
      })),
      { currency: "PHP", fxRate: "0.017234" },
    );

    const { entry } = await approveWorkOrder({
      companyId: fixture.company.id,
      workOrderId: workOrder.id,
    });

    const rounding = entry.lines.find(
      (line) => line.accountId === fixture.system(SYSTEM_ACCOUNTS.FX_ROUNDING_DIFFERENCE).id,
    );
    expect(rounding).toBeDefined();

    // Every expense line is its own converted amount, untouched by the fix.
    const feeLines = entry.lines.filter((line) => line.accountId === fixture.code("5000").id);
    expect(feeLines).toHaveLength(7);
    for (const line of feeLines) expect(line.debit.toFixed(2)).toBe("57.45");

    const tb = await trialBalance({
      companyId: fixture.company.id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });
    expect(tb.balanced).toBe(true);
  });
});

describe("expenses (SPEC §8.2)", () => {
  let fixture: Fixture;
  let vendor: Awaited<ReturnType<typeof makeVendor>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Expense Co", "PHP");
    vendor = await makeVendor(fixture.company.id, "REGULAR", { name: "Globe Telecom" });
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("posts a direct expense straight against the bank and is terminal", async () => {
    const { expense, entry } = await recordExpense({
      companyId: fixture.company.id,
      kind: "DIRECT",
      vendorId: vendor.id,
      date: new Date(Date.UTC(2026, 7, 20)),
      currency: "PHP",
      amount: "2400.00",
      expenseAccountId: fixture.code("6400").id,
      paymentAccountId: fixture.code("1000").id,
      description: "August internet",
    });

    expect(expense.status).toBe("PAID");
    expect(money(expense.balanceDue).toFixed(2)).toBe("0.00");
    expect(entry.lines.find((l) => l.accountId === fixture.code("6400").id)?.debit.toFixed(2)).toBe("2400.00");
    expect(entry.lines.find((l) => l.accountId === fixture.code("1000").id)?.credit.toFixed(2)).toBe("2400.00");
  });

  it("posts a bill to A/P and clears it with a payment", async () => {
    const { expense, entry } = await recordExpense({
      companyId: fixture.company.id,
      kind: "BILL",
      vendorId: vendor.id,
      date: new Date(Date.UTC(2026, 7, 20)),
      dueDate: new Date(Date.UTC(2026, 8, 20)),
      currency: "PHP",
      amount: "18000.00",
      expenseAccountId: fixture.code("6200").id,
      description: "September rent",
    });

    expect(expense.status).toBe("APPROVED");
    const payable = entry.lines.find(
      (line) => line.accountId === fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE).id,
    );
    expect(payable?.credit.toFixed(2)).toBe("18000.00");
    expect(payable?.vendorId).toBe(vendor.id);

    await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: vendor.id,
      date: new Date(Date.UTC(2026, 8, 18)),
      amount: "18000.00",
      currency: "PHP",
      paymentAccountId: fixture.code("1000").id,
      applications: [{ expenseId: expense.id, amountApplied: "18000.00" }],
    });

    const settled = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(settled.status).toBe("PAID");
    expect(
      (
        await accountBalance({
          companyId: fixture.company.id,
          accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE).id,
          asOf: new Date(Date.UTC(2026, 11, 31)),
        })
      ).toFixed(2),
    ).toBe("0.00");
  });

  it("insists a direct expense names the account it was paid from", async () => {
    await expect(
      recordExpense({
        companyId: fixture.company.id,
        kind: "DIRECT",
        vendorId: vendor.id,
        date: new Date(Date.UTC(2026, 7, 20)),
        currency: "PHP",
        amount: "100.00",
        expenseAccountId: fixture.code("6100").id,
        description: "Supplies",
      }),
    ).rejects.toThrow(/needs the account it was paid from/);
  });

  it("insists a bill names the vendor it is owed to", async () => {
    await expect(
      recordExpense({
        companyId: fixture.company.id,
        kind: "BILL",
        date: new Date(Date.UTC(2026, 7, 20)),
        currency: "PHP",
        amount: "100.00",
        expenseAccountId: fixture.code("6100").id,
        description: "Supplies",
      }),
    ).rejects.toThrow(/needs a vendor/);
  });

  it("refuses to settle a direct expense — there is nothing owing", async () => {
    const { expense } = await recordExpense({
      companyId: fixture.company.id,
      kind: "DIRECT",
      vendorId: vendor.id,
      date: new Date(Date.UTC(2026, 7, 20)),
      currency: "PHP",
      amount: "500.00",
      expenseAccountId: fixture.code("6100").id,
      paymentAccountId: fixture.code("1000").id,
      description: "Supplies",
    });

    await expect(
      recordBillPayment({
        companyId: fixture.company.id,
        vendorId: vendor.id,
        date: new Date(Date.UTC(2026, 7, 25)),
        amount: "500.00",
        currency: "PHP",
        paymentAccountId: fixture.code("1000").id,
        applications: [{ expenseId: expense.id, amountApplied: "500.00" }],
      }),
    ).rejects.toThrow(/paid when it was recorded/);
  });
});

describe("A/P aging (SPEC §12.6)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Aging AP Co", "PHP");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("separates consultants from regular vendors and ties unfiltered", async () => {
    const { apAging } = await import("@/lib/payables/aging");
    const consultant = await makeVendor(fixture.company.id, "CONSULTANT", { name: "Chareze" });
    const supplier = await makeVendor(fixture.company.id, "REGULAR", { name: "Meralco" });
    const asOf = new Date(Date.UTC(2026, 9, 15));

    const workOrder = await makeWorkOrder(
      fixture,
      consultant.id,
      [{ description: "Consultation", quantity: "1", rate: "25000.00", code: "5000" }],
      { issueDate: new Date(Date.UTC(2026, 8, 1)) },
    );
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: workOrder.id });

    await recordExpense({
      companyId: fixture.company.id,
      kind: "BILL",
      vendorId: supplier.id,
      date: new Date(Date.UTC(2026, 8, 5)),
      dueDate: new Date(Date.UTC(2026, 9, 5)),
      currency: "PHP",
      amount: "9500.00",
      expenseAccountId: fixture.code("6250").id,
      description: "September electricity",
    });

    const all = await apAging({ companyId: fixture.company.id, asOf });
    expect(all.totals.total.toFixed(2)).toBe("34500.00");
    expect(all.controlBalance.toFixed(2)).toBe("34500.00");
    expect(all.tiesToLedger).toBe(true);

    const consultantsOnly = await apAging({
      companyId: fixture.company.id,
      asOf,
      kind: "CONSULTANT",
    });
    expect(consultantsOnly.rows.map((row) => row.vendorName)).toEqual(["Chareze"]);
    expect(consultantsOnly.totals.total.toFixed(2)).toBe("25000.00");

    const vendorsOnly = await apAging({ companyId: fixture.company.id, asOf, kind: "REGULAR" });
    expect(vendorsOnly.rows.map((row) => row.vendorName)).toEqual(["Meralco"]);
    expect(vendorsOnly.totals.total.toFixed(2)).toBe("9500.00");
    // A filtered view is a subset of the control account, so it does not claim to tie.
    expect(vendorsOnly.tiesToLedger).toBeNull();
  });
});
