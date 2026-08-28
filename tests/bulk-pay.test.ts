import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_BULK_PAYMENTS,
  payableWorkOrders,
  planBulkPay,
  recordBulkPay,
} from "@/lib/payables/bulk-pay";
import { approveWorkOrder } from "@/lib/payables/work-orders";
import { closeBooksThrough } from "@/lib/periods/close";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { accountBalance } from "@/lib/ledger/reports";
import { money } from "@/lib/money";
import { makeCompanyWithChart, makeUser, makeVendor, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const DATE = new Date(Date.UTC(2026, 7, 15));
const PAID_ON = new Date(Date.UTC(2026, 7, 28));
const AS_OF = new Date(Date.UTC(2026, 11, 31));

/**
 * SPEC §6: settling many work orders in one action.
 *
 * The point of these tests is the seam a bulk action introduces — that the
 * selection becomes one payment per consultant, that a run which cannot finish
 * says who it could not pay rather than unwinding what it could, and that the
 * ledger lands exactly where eighteen separate payments would have left it.
 */
describe("paying work orders in bulk", () => {
  let fixture: Fixture;
  let owner: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Bulk Pay Co", "PHP");
    owner = await makeUser("OWNER", fixture.company.id);
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const consultant = (name: string) => makeVendor(fixture.company.id, "CONSULTANT", { name });

  const workOrder = async (vendorId: string, total = "10000.00", currency = "PHP") => {
    const created = await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId,
        issueDate: DATE,
        dueDate: DATE,
        currency,
        fxRate: currency === "PHP" ? "1" : "56",
        total,
        balanceDue: total,
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "Consultation",
              quantity: "1",
              rate: total,
              amount: total,
              accountId: fixture.code("5000").id,
            },
          ],
        },
      },
    });
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: created.id });
    return prisma.workOrder.findFirstOrThrow({ where: { id: created.id } });
  };

  const run = (
    lines: { workOrderId: string; amount: string }[],
    overrides: Partial<Parameters<typeof recordBulkPay>[0]> = {},
  ) =>
    recordBulkPay({
      companyId: fixture.company.id,
      lines,
      date: PAID_ON,
      paymentAccountId: fixture.code("1000").id,
      userId: owner.id,
      role: "OWNER",
      ...overrides,
    });

  const whole = (orders: { id: string; balanceDue: unknown }[]) =>
    orders.map((order) => ({
      workOrderId: order.id,
      amount: money(order.balanceDue as never).toFixed(2),
    }));

  it("lists only work orders with something still owing", async () => {
    const abigail = await consultant("Abigail Bautista");
    const open = await workOrder(abigail.id);
    const settled = await workOrder(abigail.id, "5000.00");
    await run(whole([settled]));

    const payable = await payableWorkOrders({ companyId: fixture.company.id });
    expect(payable.map((order) => order.id)).toEqual([open.id]);
  });

  it("makes one payment per consultant, not one for the run", async () => {
    const abigail = await consultant("Abigail Bautista");
    const jocelyn = await consultant("Jocelyn Superable");
    const orders = [
      await workOrder(abigail.id, "9000.00"),
      await workOrder(abigail.id, "1000.00"),
      await workOrder(jocelyn.id, "8000.00"),
    ];

    const result = await run(whole(orders));

    expect(result.paid).toHaveLength(2);
    expect(result.failed).toHaveLength(0);

    // Abigail's two work orders are one payment of 10,000, not two of hers
    // and not one of 18,000 spanning both people.
    const payments = await prisma.billPayment.findMany({
      include: { applications: true },
      orderBy: { amount: "desc" },
    });
    expect(payments).toHaveLength(2);
    expect(money(payments[0].amount).toFixed(2)).toBe("10000.00");
    expect(payments[0].vendorId).toBe(abigail.id);
    expect(payments[0].applications).toHaveLength(2);
    expect(money(payments[1].amount).toFixed(2)).toBe("8000.00");
    expect(payments[1].vendorId).toBe(jocelyn.id);
  });

  it("clears accounts payable and takes the cash, exactly as single payments would", async () => {
    const abigail = await consultant("Abigail Bautista");
    const jocelyn = await consultant("Jocelyn Superable");
    const orders = [
      await workOrder(abigail.id, "9000.00"),
      await workOrder(jocelyn.id, "8000.00"),
    ];

    const cashAccount = { companyId: fixture.company.id, accountId: fixture.code("1000").id, asOf: AS_OF };
    const before = await accountBalance(cashAccount);
    await run(whole(orders));

    const payable = await accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE).id,
      asOf: AS_OF,
    });
    const cash = await accountBalance(cashAccount);

    expect(money(payable).toFixed(2)).toBe("0.00");
    expect(money(before).minus(money(cash)).toFixed(2)).toBe("17000.00");

    for (const order of orders) {
      const settled = await prisma.workOrder.findFirstOrThrow({ where: { id: order.id } });
      expect(settled.status).toBe("PAID");
      expect(money(settled.balanceDue).toFixed(2)).toBe("0.00");
    }
  });

  it("part-pays when a smaller amount is given", async () => {
    const abigail = await consultant("Abigail Bautista");
    const order = await workOrder(abigail.id, "10000.00");

    await run([{ workOrderId: order.id, amount: "4000.00" }]);

    const after = await prisma.workOrder.findFirstOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PARTIALLY_PAID");
    expect(money(after.balanceDue).toFixed(2)).toBe("6000.00");

    // Still listed, for the rest of it.
    const payable = await payableWorkOrders({ companyId: fixture.company.id });
    expect(payable.map((entry) => entry.id)).toEqual([order.id]);
  });

  it("refuses to pay more than is owed, and says which document", async () => {
    const abigail = await consultant("Abigail Bautista");
    const order = await workOrder(abigail.id, "1000.00");

    const plan = await planBulkPay({
      companyId: fixture.company.id,
      lines: [{ workOrderId: order.id, amount: "5000.00" }],
    });

    expect(plan.payable).toHaveLength(0);
    expect(plan.excluded[0].excludedReason).toMatch(/only owed 1000\.00/);
    await expect(run([{ workOrderId: order.id, amount: "5000.00" }])).rejects.toThrow(
      /None of the selected work orders can be paid/,
    );
    expect(await prisma.billPayment.count()).toBe(0);
  });

  it("leaves out a consultant holding two currencies rather than guessing", async () => {
    const abigail = await consultant("Abigail Bautista");
    const jocelyn = await consultant("Jocelyn Superable");
    const orders = [
      await workOrder(abigail.id, "1000.00", "PHP"),
      await workOrder(abigail.id, "500.00", "USD"),
      await workOrder(jocelyn.id, "8000.00"),
    ];

    const result = await run(whole(orders));

    expect(result.paid.map((entry) => entry.consultantName)).toEqual(["Jocelyn Superable"]);
    expect(result.skipped[0].excludedReason).toMatch(/PHP and USD|USD and PHP/);
    // The one that could be paid was, which is the whole point of not
    // running the batch in a single transaction.
    expect(await prisma.billPayment.count()).toBe(1);
  });

  it("pays everyone it can when one consultant fails, and names the one it could not", async () => {
    const abigail = await consultant("Abigail Bautista");
    const jocelyn = await consultant("Jocelyn Superable");
    const abigailOrder = await workOrder(abigail.id, "9000.00");
    // A lone USD work order plans cleanly — one currency — but cannot be
    // recorded without a rate. A genuine failure at posting time, which is
    // exactly the case a run must survive.
    const jocelynOrder = await workOrder(jocelyn.id, "500.00", "USD");

    const result = await run(whole([abigailOrder, jocelynOrder]));

    expect(result.paid.map((entry) => entry.consultantName)).toEqual(["Abigail Bautista"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].consultantName).toBe("Jocelyn Superable");
    expect(result.failed[0].reason).toMatch(/exchange rate/i);

    // The one that worked stayed worked. Rolling it back to keep the run
    // atomic would leave a payment run that has to be redone from scratch.
    expect(await prisma.billPayment.count()).toBe(1);
    const paid = await prisma.workOrder.findFirstOrThrow({ where: { id: abigailOrder.id } });
    expect(paid.status).toBe("PAID");
    const untouched = await prisma.workOrder.findFirstOrThrow({ where: { id: jocelynOrder.id } });
    expect(untouched.status).toBe("APPROVED");
    expect(money(untouched.balanceDue).toFixed(2)).toBe("500.00");
  });

  it("refuses the whole run when the period is closed", async () => {
    const abigail = await consultant("Abigail Bautista");
    const order = await workOrder(abigail.id, "9000.00");
    await closeBooksThrough(
      { companyId: fixture.company.id, userId: owner.id, role: "OWNER" },
      new Date(Date.UTC(2026, 7, 31)),
    );

    const result = await run(whole([order]), { role: "BOOKKEEPER" });

    expect(result.paid).toHaveLength(0);
    expect(result.failed[0].reason).toMatch(/closed/i);
    expect(await prisma.billPayment.count()).toBe(0);
  });

  it("writes one audit row for the run, naming who was paid", async () => {
    const abigail = await consultant("Abigail Bautista");
    const order = await workOrder(abigail.id, "9000.00");

    await run(whole([order]), { reference: "Payroll 28 Aug" });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "work_order.bulk_paid" },
    });
    const data = audit.data as { paid: { consultant: string }[]; reference: string };
    expect(data.paid[0].consultant).toBe("Abigail Bautista");
    expect(data.reference).toBe("Payroll 28 Aug");
    expect(audit.summary).toContain("1 consultant(s) paid");
  });

  it("will not reach into another company's work orders", async () => {
    const abigail = await consultant("Abigail Bautista");
    const order = await workOrder(abigail.id, "9000.00");
    const elsewhere = await makeCompanyWithChart("Elsewhere", "PHP");

    await expect(
      recordBulkPay({
        companyId: elsewhere.company.id,
        lines: whole([order]),
        date: PAID_ON,
        paymentAccountId: elsewhere.code("1000").id,
        userId: owner.id,
        role: "OWNER",
      }),
    ).rejects.toThrow(/No work orders selected/);
    expect(await prisma.billPayment.count()).toBe(0);
  });

  it("refuses an empty selection, and caps how big one run can be", async () => {
    await expect(run([])).rejects.toThrow(/No work orders selected/);
    expect(MAX_BULK_PAYMENTS).toBe(100);
  });
});
