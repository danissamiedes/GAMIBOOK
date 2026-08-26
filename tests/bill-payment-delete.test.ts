import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { approveWorkOrder, computeWorkOrderLine } from "@/lib/payables/work-orders";
import {
  deleteBillPayment,
  recordBillPayment,
  reverseBillPayment,
  whyNotDeletable,
} from "@/lib/payables/bill-payments";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { accountBalance } from "@/lib/ledger/reports";
import { money } from "@/lib/money";
import { makeCompanyWithChart, makeUser, makeVendor, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

/**
 * SPEC §4.2 rule 3 says posted entries are immutable. Delete is the
 * one exception, so these tests care as much about what it refuses as about
 * what it does.
 */
describe("deleting a bill payment recorded by mistake", () => {
  let fixture: Fixture;
  let consultant: Awaited<ReturnType<typeof makeVendor>>;
  let owner: Awaited<ReturnType<typeof makeUser>>;

  const ap = () =>
    accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE).id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });

  async function payableWorkOrder(rate: string) {
    const workOrder = await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: consultant.id,
        issueDate: new Date(Date.UTC(2026, 7, 15)),
        dueDate: new Date(Date.UTC(2026, 7, 30)),
        currency: "PHP",
        fxRate: "1",
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "Work",
              quantity: "1",
              rate,
              amount: computeWorkOrderLine({ quantity: "1", rate }),
              accountId: fixture.code("5000").id,
            },
          ],
        },
      },
    });
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: workOrder.id });
    return workOrder;
  }

  async function pay(workOrderId: string, amount: string, userId = owner.id) {
    return recordBillPayment({
      companyId: fixture.company.id,
      vendorId: consultant.id,
      date: new Date(Date.UTC(2026, 8, 1)),
      amount,
      currency: "PHP",
      paymentAccountId: fixture.code("1000").id,
      applications: [{ workOrderId, amountApplied: amount }],
      userId,
      role: "OWNER",
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Delete Co");
    consultant = await makeVendor(fixture.company.id, "CONSULTANT");
    owner = await makeUser("OWNER", fixture.company.id);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("removes the payment, its applications and its entry, and reopens the document", async () => {
    const workOrder = await payableWorkOrder("9000.00");
    const { payment, entry } = await pay(workOrder.id, "4000.00");

    expect(
      (await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })).status,
    ).toBe("PARTIALLY_PAID");

    await deleteBillPayment({
      companyId: fixture.company.id,
      billPaymentId: payment.id,
      userId: owner.id,
    });

    expect(await prisma.billPayment.findUnique({ where: { id: payment.id } })).toBeNull();
    expect(await prisma.journalEntry.findUnique({ where: { id: entry.id } })).toBeNull();
    expect(await prisma.journalLine.count({ where: { journalEntryId: entry.id } })).toBe(0);
    expect(await prisma.billPaymentApplication.count({ where: { billPaymentId: payment.id } })).toBe(0);

    const restored = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } });
    expect(restored.status).toBe("APPROVED");
    expect(money(restored.balanceDue).toFixed(2)).toBe("9000.00");
    expect(money(restored.amountPaid).toFixed(2)).toBe("0.00");
    expect(money(restored.baseRelieved).toFixed(2)).toBe("0.00");
    expect((await ap()).toFixed(2)).toBe("9000.00");
  });

  it("keeps the whole payment in the audit trail", async () => {
    const workOrder = await payableWorkOrder("9000.00");
    const { payment, entry } = await pay(workOrder.id, "4000.00");

    await deleteBillPayment({
      companyId: fixture.company.id,
      billPaymentId: payment.id,
      userId: owner.id,
    });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "billPayment.deleted", entityId: payment.id },
    });
    expect(audit.userId).toBe(owner.id);
    const data = audit.data as {
      payment: { amount: string; currency: string };
      applications: { workOrderId: string | null; amountApplied: string }[];
      entry: { entryNumber: number; lines: { debit: string; credit: string }[] };
    };
    expect(data.payment.amount).toBe("4000.00");
    expect(data.payment.currency).toBe("PHP");
    expect(data.applications).toEqual([
      { workOrderId: workOrder.id, expenseId: null, amountApplied: "4000.00" },
    ]);
    expect(data.entry.entryNumber).toBe(entry.entryNumber);
    expect(data.entry.lines).toHaveLength(entry.lines.length);
  });

  it("leaves the entry number unused rather than handing it out again", async () => {
    const workOrder = await payableWorkOrder("9000.00");
    const { payment, entry } = await pay(workOrder.id, "4000.00");

    await deleteBillPayment({
      companyId: fixture.company.id,
      billPaymentId: payment.id,
      userId: owner.id,
    });

    const { entry: next } = await pay(workOrder.id, "4000.00");
    expect(next.entryNumber).toBeGreaterThan(entry.entryNumber);
  });

  it("lets the owner delete a payment a bookkeeper recorded", async () => {
    // Authorship is not a gate. Whoever finds the mistake can clear it up,
    // for as long as the period holding it is open.
    const other = await makeUser("BOOKKEEPER", fixture.company.id);
    const workOrder = await payableWorkOrder("9000.00");
    const { payment } = await pay(workOrder.id, "4000.00", other.id);

    await deleteBillPayment({
      companyId: fixture.company.id,
      billPaymentId: payment.id,
      userId: owner.id,
    });

    expect(await prisma.billPayment.findUnique({ where: { id: payment.id } })).toBeNull();
  });

  it("refuses a payment that has already been reversed", async () => {
    const workOrder = await payableWorkOrder("9000.00");
    const { payment } = await pay(workOrder.id, "4000.00");
    await reverseBillPayment({
      companyId: fixture.company.id,
      billPaymentId: payment.id,
      date: new Date(Date.UTC(2026, 8, 5)),
      userId: owner.id,
      role: "OWNER",
    });

    await expect(
      deleteBillPayment({
        companyId: fixture.company.id,
        billPaymentId: payment.id,
        userId: owner.id,
      }),
    ).rejects.toThrow(/already been reversed/);
  });

  it("refuses a payment a bank line is matched to", async () => {
    const workOrder = await payableWorkOrder("9000.00");
    const { payment } = await pay(workOrder.id, "4000.00");

    const bankAccount = await prisma.bankAccount.create({
      data: {
        companyId: fixture.company.id,
        name: "Main",
        accountId: fixture.code("1000").id,
        currency: "PHP",
      },
    });
    await prisma.bankTransaction.create({
      data: {
        companyId: fixture.company.id,
        bankAccountId: bankAccount.id,
        date: new Date(Date.UTC(2026, 8, 1)),
        description: "Transfer",
        amount: "-4000.00",
        status: "MATCHED",
        matchedBillPaymentId: payment.id,
        dedupeHash: "hash-1",
      },
    });

    await expect(
      deleteBillPayment({
        companyId: fixture.company.id,
        billPaymentId: payment.id,
        userId: owner.id,
      }),
    ).rejects.toThrow(/bank line is matched/);
  });

  it("refuses a payment dated inside a closed period", async () => {
    const workOrder = await payableWorkOrder("9000.00");
    const { payment } = await pay(workOrder.id, "4000.00");
    await prisma.company.update({
      where: { id: fixture.company.id },
      data: { booksClosedThrough: new Date(Date.UTC(2026, 8, 30)) },
    });

    await expect(
      deleteBillPayment({
        companyId: fixture.company.id,
        billPaymentId: payment.id,
        userId: owner.id,
      }),
    ).rejects.toThrow(/books are closed through/);
  });

  it("refuses a payment from another company", async () => {
    const other = await makeCompanyWithChart("Other Co");
    const workOrder = await payableWorkOrder("9000.00");
    const { payment } = await pay(workOrder.id, "4000.00");

    await expect(
      deleteBillPayment({
        companyId: other.company.id,
        billPaymentId: payment.id,
        userId: owner.id,
      }),
    ).rejects.toThrow(/not found in this company/);
  });

  it("still refuses every other entry delete", async () => {
    const workOrder = await payableWorkOrder("9000.00");
    const { entry } = await pay(workOrder.id, "4000.00");

    await expect(prisma.journalEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
      /immutable/,
    );
  });

  it("does not let the hatch stay open for a second entry", async () => {
    const workOrder = await payableWorkOrder("9000.00");
    const first = await pay(workOrder.id, "2000.00");
    const second = await pay(workOrder.id, "2000.00");

    // Name one entry, try to delete the other in the same transaction.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('ledger.allow_entry_delete', ${first.entry.id}, true)`;
        await tx.journalEntry.delete({ where: { id: second.entry.id } });
      }),
    ).rejects.toThrow(/immutable/);
  });
});

describe("whyNotDeletable", () => {
  const base = {
    payment: { reversedAt: null, createdAt: new Date() },
    entry: {
      date: new Date(Date.UTC(2026, 7, 1)),
      reversedByEntryId: null,
    },
    bankMatchCount: 0,
    booksClosedThrough: null,
  };

  it("allows a payment in an open period", () => {
    expect(whyNotDeletable(base)).toBeNull();
  });

  it("does not care how long ago it was recorded", () => {
    // Age is not a reason. The close is.
    const old = { ...base, payment: { reversedAt: null, createdAt: new Date(Date.UTC(2025, 0, 2)) } };
    expect(whyNotDeletable(old)).toBeNull();
  });

  it("refuses once the period holding it is closed", () => {
    const closed = { ...base, booksClosedThrough: new Date(Date.UTC(2026, 7, 31)) };
    expect(whyNotDeletable(closed)).toMatch(/books are closed through 08\/31\/2026/);
  });

  it("refuses when there is no posting at all", () => {
    expect(whyNotDeletable({ ...base, entry: null })).toMatch(/No posting was found/);
  });
});
