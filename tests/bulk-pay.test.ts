import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_BULK_PAYMENTS,
  payableConsultantDocuments,
  planBulkPay,
  recordBulkPay,
  type BulkPayLine,
} from "@/lib/payables/bulk-pay";
import { closeBooksThrough } from "@/lib/periods/close";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { accountBalance } from "@/lib/ledger/reports";
import { money } from "@/lib/money";
import { makeCompanyWithChart, makeUser, makeVendor, prisma, resetDatabase, approveAsLegacyWorkOrder } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const DATE = new Date(Date.UTC(2026, 7, 15));
const PAID_ON = new Date(Date.UTC(2026, 7, 28));
const AS_OF = new Date(Date.UTC(2026, 11, 31));

/**
 * SPEC §6: settling what several consultants are owed in one action.
 *
 * The point of these tests is the seam a bulk action introduces — that the
 * selection becomes one payment per consultant, that a run which cannot finish
 * says who it could not pay rather than unwinding what it could, and that the
 * ledger lands exactly where eighteen separate payments would have left it.
 *
 * Most of them are written against work orders raised under the earlier flow,
 * which posted on approval and are payable in their own right. They are the
 * awkward case and they still have to work; bills, which are the ordinary
 * case now, get their own section at the end.
 */
describe("paying consultants in bulk", () => {
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
    await approveAsLegacyWorkOrder(fixture.company.id, created.id);
    return prisma.workOrder.findFirstOrThrow({ where: { id: created.id } });
  };

  const run = (
    lines: BulkPayLine[],
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

  /** Every one of these, paid in full. */
  const whole = (
    documents: { id: string; balanceDue: unknown }[],
    kind: "workOrder" | "bill" = "workOrder",
  ): BulkPayLine[] =>
    documents.map((document) => ({
      kind,
      documentId: document.id,
      amount: money(document.balanceDue as never).toFixed(2),
    }));

  it("lists only work orders with something still owing", async () => {
    const abigail = await consultant("Abigail Bautista");
    const open = await workOrder(abigail.id);
    const settled = await workOrder(abigail.id, "5000.00");
    await run(whole([settled]));

    const payable = await payableConsultantDocuments({ companyId: fixture.company.id });
    expect(payable.map((document) => document.id)).toEqual([open.id]);
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

    await run([{ kind: "workOrder" as const, documentId: order.id, amount: "4000.00" }]);

    const after = await prisma.workOrder.findFirstOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PARTIALLY_PAID");
    expect(money(after.balanceDue).toFixed(2)).toBe("6000.00");

    // Still listed, for the rest of it.
    const payable = await payableConsultantDocuments({ companyId: fixture.company.id });
    expect(payable.map((entry) => entry.id)).toEqual([order.id]);
  });

  it("refuses to pay more than is owed, and says which document", async () => {
    const abigail = await consultant("Abigail Bautista");
    const order = await workOrder(abigail.id, "1000.00");

    const plan = await planBulkPay({
      companyId: fixture.company.id,
      lines: [{ kind: "workOrder" as const, documentId: order.id, amount: "5000.00" }],
    });

    expect(plan.payable).toHaveLength(0);
    expect(plan.excluded[0].excludedReason).toMatch(/only owed 1000\.00/);
    await expect(
      run([{ kind: "workOrder" as const, documentId: order.id, amount: "5000.00" }]),
    ).rejects.toThrow(/None of the selected documents can be paid/);
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
      where: { action: "consultant_bill.bulk_paid" },
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
    ).rejects.toThrow(/Nothing selected is still outstanding/);
    expect(await prisma.billPayment.count()).toBe(0);
  });

  describe("consultant bills, which is what is normally being paid", () => {
    const bill = async (vendorId: string, total = "7000.00", reference = "CB-1") => {
      const { recordExpense } = await import("@/lib/payables/expenses");
      const { expense } = await recordExpense({
        companyId: fixture.company.id,
        kind: "BILL",
        vendorId,
        date: DATE,
        dueDate: DATE,
        currency: "PHP",
        amount: total,
        expenseAccountId: fixture.code("5000").id,
        description: "Agreed cost",
        reference,
        userId: owner.id,
        role: "OWNER",
      });
      return expense;
    };

    it("lists a consultant's open bills and leaves a supplier's alone", async () => {
      const abigail = await consultant("Abigail Bautista");
      const theirs = await bill(abigail.id);

      // A regular vendor's bill is the Vendors section's business and is
      // settled on its own screen; it must not turn up in a consultant run.
      const supplier = await makeVendor(fixture.company.id, "REGULAR", { name: "DAVAO LIGHT" });
      const { recordExpense } = await import("@/lib/payables/expenses");
      await recordExpense({
        companyId: fixture.company.id,
        kind: "BILL",
        vendorId: supplier.id,
        date: DATE,
        dueDate: DATE,
        currency: "PHP",
        amount: "2500.00",
        expenseAccountId: fixture.code("6100").id,
        description: "Power",
        reference: "DL-1",
      });

      const payable = await payableConsultantDocuments({ companyId: fixture.company.id });
      expect(payable.map((document) => document.id)).toEqual([theirs.id]);
      expect(payable[0].kind).toBe("bill");
      expect(payable[0].label).toBe("CB-1");
    });

    it("pays a bill and clears it from accounts payable", async () => {
      const abigail = await consultant("Abigail Bautista");
      const theirs = await bill(abigail.id, "7000.00");

      const result = await run(whole([theirs], "bill"));
      expect(result.paid).toHaveLength(1);

      const settled = await prisma.expense.findFirstOrThrow({ where: { id: theirs.id } });
      expect(settled.status).toBe("PAID");
      expect(money(settled.balanceDue).toFixed(2)).toBe("0.00");
      expect(
        money(
          await accountBalance({
            companyId: fixture.company.id,
            accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE).id,
            asOf: AS_OF,
          }),
        ).toFixed(2),
      ).toBe("0.00");
    });

    it("settles a bill and an old work order for one consultant in one payment", async () => {
      // The reason both kinds share a screen: a consultant owed on each gets
      // one cheque, not two.
      const abigail = await consultant("Abigail Bautista");
      const order = await workOrder(abigail.id, "9000.00");
      const theirs = await bill(abigail.id, "1000.00", "CB-2");

      const result = await run([...whole([order]), ...whole([theirs], "bill")]);
      expect(result.paid).toHaveLength(1);

      const payments = await prisma.billPayment.findMany({ include: { applications: true } });
      expect(payments).toHaveLength(1);
      expect(money(payments[0].amount).toFixed(2)).toBe("10000.00");
      // One payment, two applications — one against each kind of document.
      expect(payments[0].applications).toHaveLength(2);
      expect(payments[0].applications.filter((row) => row.expenseId)).toHaveLength(1);
      expect(payments[0].applications.filter((row) => row.workOrderId)).toHaveLength(1);
    });

    it("part-pays a bill, and keeps the rest on the list", async () => {
      const abigail = await consultant("Abigail Bautista");
      const theirs = await bill(abigail.id, "7000.00");

      await run([{ kind: "bill", documentId: theirs.id, amount: "3000.00" }]);

      const after = await prisma.expense.findFirstOrThrow({ where: { id: theirs.id } });
      expect(after.status).toBe("PARTIALLY_PAID");
      expect(money(after.balanceDue).toFixed(2)).toBe("4000.00");

      const payable = await payableConsultantDocuments({ companyId: fixture.company.id });
      expect(payable.map((entry) => entry.id)).toEqual([theirs.id]);
      expect(money(payable[0].balanceDue).toFixed(2)).toBe("4000.00");
    });

    it("leaves out a work order that has already become a bill", async () => {
      // Converting posts the cost once, on the bill. Offering the work order
      // as well would invite paying the same work twice.
      const { approveWorkOrder, convertWorkOrderToBill } = await import(
        "@/lib/payables/work-orders"
      );
      const abigail = await consultant("Abigail Bautista");
      const draft = await prisma.workOrder.create({
        data: {
          companyId: fixture.company.id,
          vendorId: abigail.id,
          issueDate: DATE,
          dueDate: DATE,
          currency: "PHP",
          lines: {
            create: [
              {
                lineNumber: 1,
                description: "Site work",
                quantity: "1",
                rate: "4000.00",
                amount: "4000.00",
                accountId: fixture.code("5000").id,
              },
            ],
          },
        },
      });
      await approveWorkOrder({ companyId: fixture.company.id, workOrderId: draft.id });

      // Approved and unbilled: nothing has posted, so nothing is owed yet.
      expect(await payableConsultantDocuments({ companyId: fixture.company.id })).toHaveLength(0);

      await convertWorkOrderToBill({ companyId: fixture.company.id, workOrderId: draft.id });

      const payable = await payableConsultantDocuments({ companyId: fixture.company.id });
      expect(payable).toHaveLength(1);
      expect(payable[0].kind).toBe("bill");
    });
  });

  it("refuses an empty selection, and caps how big one run can be", async () => {
    await expect(run([])).rejects.toThrow(/Nothing selected/);
    expect(MAX_BULK_PAYMENTS).toBe(100);
  });
});
