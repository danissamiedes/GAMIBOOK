import { beforeEach, describe, expect, it } from "vitest";
import {
  approveWorkOrder,
  convertWorkOrderToBill,
  convertWorkOrdersToBills,
  deleteWorkOrder,
  updateWorkOrder,
  voidWorkOrder,
} from "@/lib/payables/work-orders";
import { openDocumentsForVendor, recordBillPayment } from "@/lib/payables/bill-payments";
import { apAging } from "@/lib/payables/aging";
import { trialBalance } from "@/lib/ledger/reports";
import { balancesByAccount } from "@/lib/reports/balances";
import {
  approveAsLegacyWorkOrder,
  makeCompanyWithChart,
  makeUser,
  prisma,
  resetDatabase,
} from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

let fixture: Fixture;
let owner: Awaited<ReturnType<typeof makeUser>>;
let consultant: Awaited<ReturnType<typeof prisma.vendor.create>>;

const ISSUE = new Date("2026-07-10");
const YEAR_END = new Date("2026-12-31");

beforeEach(async () => {
  await resetDatabase();
  fixture = await makeCompanyWithChart("KASAGAMI APARTMENTS");
  owner = await makeUser("OWNER", fixture.company.id);
  consultant = await prisma.vendor.create({
    data: {
      companyId: fixture.company.id,
      kind: "CONSULTANT",
      name: "DANNY",
      defaultCurrency: "PHP",
      paymentTermsDays: 15,
    },
  });
});

async function draft(lines?: { amount: string; accountId: string }[]) {
  const rows = lines ?? [{ amount: "20000.00", accountId: fixture.code("5000").id }];
  return prisma.workOrder.create({
    data: {
      companyId: fixture.company.id,
      vendorId: consultant.id,
      issueDate: ISSUE,
      dueDate: new Date("2026-07-25"),
      currency: "PHP",
      lines: {
        create: rows.map((row, index) => ({
          lineNumber: index + 1,
          description: `Line ${index + 1}`,
          quantity: "1",
          rate: row.amount,
          amount: row.amount,
          accountId: row.accountId,
        })),
      },
    },
  });
}

const balanceOf = async (accountId: string) => {
  const rows = await balancesByAccount({ companyId: fixture.company.id, to: YEAR_END });
  return rows.find((row) => row.accountId === accountId)?.amount.toFixed(2) ?? "0.00";
};

describe("a work order is a commitment until it is billed (SPEC §8.1b)", () => {
  it("approves with a number and posts nothing", async () => {
    const order = await draft();
    const { workOrder, entry } = await approveWorkOrder({
      companyId: fixture.company.id,
      workOrderId: order.id,
      userId: owner.id,
      role: "OWNER",
    });

    expect(workOrder.status).toBe("APPROVED");
    expect(workOrder.workOrderNumber).toMatch(/^WO\d+$/);
    expect(entry).toBeNull();
    expect(await prisma.journalEntry.count()).toBe(0);
    expect(await balanceOf(fixture.system("ACCOUNTS_PAYABLE").id)).toBe("0.00");

    // And it is not offered for payment: there is nothing owed yet.
    expect(await openDocumentsForVendor(fixture.company.id, consultant.id)).toEqual([]);
    const aging = await apAging({ companyId: fixture.company.id, asOf: YEAR_END });
    expect(aging.totals.total.toFixed(2)).toBe("0.00");
  });

  it("posts when it becomes a bill, carrying every line to its own account", async () => {
    const order = await draft([
      { amount: "20000.00", accountId: fixture.code("5000").id },
      // A recovered cash advance: negative, and against a different account.
      { amount: "-5000.00", accountId: fixture.code("6100").id },
    ]);
    const { workOrder } = await approveWorkOrder({
      companyId: fixture.company.id,
      workOrderId: order.id,
      userId: owner.id,
      role: "OWNER",
    });

    const bill = await convertWorkOrderToBill({
      companyId: fixture.company.id,
      workOrderId: order.id,
      userId: owner.id,
      role: "OWNER",
    });

    expect(bill.kind).toBe("BILL");
    expect(bill.amount.toFixed(2)).toBe("15000.00");
    // The work order's number is the bill's reference and its link.
    expect(bill.reference).toBe(workOrder.workOrderNumber);
    expect(bill.workOrderId).toBe(order.id);

    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.billedAt).not.toBeNull();

    // The posting is the work order's own lines, not one lump.
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: fixture.company.id, sourceType: "EXPENSE", sourceId: bill.id },
      include: { lines: { include: { account: true }, orderBy: { lineNumber: "asc" } } },
    });
    expect(entry.lines).toHaveLength(3);
    expect(await balanceOf(fixture.code("5000").id)).toBe("20000.00");
    expect(await balanceOf(fixture.code("6100").id)).toBe("-5000.00");
    expect(await balanceOf(fixture.system("ACCOUNTS_PAYABLE").id)).toBe("15000.00");
    const tb = await trialBalance({ companyId: fixture.company.id, asOf: YEAR_END });
    expect(tb.totalDebit.toFixed(2)).toBe(tb.totalCredit.toFixed(2));
  });

  it("is the bill that gets paid, and it clears A/P", async () => {
    const order = await draft();
    await approveWorkOrder({
      companyId: fixture.company.id,
      workOrderId: order.id,
      userId: owner.id,
      role: "OWNER",
    });
    const bill = await convertWorkOrderToBill({
      companyId: fixture.company.id,
      workOrderId: order.id,
      userId: owner.id,
      role: "OWNER",
    });

    // Now — and only now — it is on the list of things to pay, as a bill.
    const open = await openDocumentsForVendor(fixture.company.id, consultant.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: bill.id, type: "expense" });

    await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: consultant.id,
      date: new Date("2026-07-26"),
      amount: "20000.00",
      currency: "PHP",
      paymentAccountId: fixture.code("1000").id,
      applications: [{ expenseId: bill.id, amountApplied: "20000.00" }],
      userId: owner.id,
    });

    const paid = await prisma.expense.findUniqueOrThrow({ where: { id: bill.id } });
    expect(paid.status).toBe("PAID");
    expect(paid.balanceDue.toFixed(2)).toBe("0.00");
    expect(await balanceOf(fixture.system("ACCOUNTS_PAYABLE").id)).toBe("0.00");
  });

  it("bills several at once, and says which ones it could not", async () => {
    const first = await draft();
    const second = await draft();
    const stillDraft = await draft();
    for (const order of [first, second]) {
      await approveWorkOrder({
        companyId: fixture.company.id,
        workOrderId: order.id,
        userId: owner.id,
        role: "OWNER",
      });
    }

    const results = await convertWorkOrdersToBills({
      companyId: fixture.company.id,
      workOrderIds: [first.id, second.id, stillDraft.id],
      userId: owner.id,
      role: "OWNER",
    });

    expect(results.filter((row) => row.expenseId)).toHaveLength(2);
    const failed = results.find((row) => row.error);
    expect(failed?.workOrderId).toBe(stillDraft.id);
    expect(failed?.error).toMatch(/approve the work order first/i);
    // The two that worked are real bills; one failure did not undo them.
    expect(await prisma.expense.count({ where: { companyId: fixture.company.id } })).toBe(2);
  });

  it("refuses to bill one twice, and refuses a work order from the old flow", async () => {
    const order = await draft();
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: order.id });
    await convertWorkOrderToBill({ companyId: fixture.company.id, workOrderId: order.id });
    await expect(
      convertWorkOrderToBill({ companyId: fixture.company.id, workOrderId: order.id }),
    ).rejects.toThrow(/already been billed/i);

    const legacy = await draft();
    await approveAsLegacyWorkOrder(fixture.company.id, legacy.id);
    await expect(
      convertWorkOrderToBill({ companyId: fixture.company.id, workOrderId: legacy.id }),
    ).rejects.toThrow(/already in accounts payable/i);
  });

  it("sends an edit or a void to the bill once there is one", async () => {
    const order = await draft();
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: order.id });
    await convertWorkOrderToBill({ companyId: fixture.company.id, workOrderId: order.id });

    await expect(
      updateWorkOrder({
        companyId: fixture.company.id,
        workOrderId: order.id,
        lines: [{ description: "More", quantity: "1", rate: "30000", accountId: fixture.code("5000").id }],
      }),
    ).rejects.toThrow(/edit the bill/i);

    await expect(
      voidWorkOrder({
        companyId: fixture.company.id,
        workOrderId: order.id,
        date: ISSUE,
      }),
    ).rejects.toThrow(/void the bill/i);
  });

  it("will not let the work order be erased once it is a bill", async () => {
    const order = await draft();
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: order.id });
    await convertWorkOrderToBill({ companyId: fixture.company.id, workOrderId: order.id });

    await expect(
      deleteWorkOrder({
        companyId: fixture.company.id,
        workOrderId: order.id,
        userId: owner.id,
      }),
    ).rejects.toThrow(/has become a bill/i);
  });

  it("lets an approved but unbilled work order still be edited", async () => {
    const order = await draft();
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: order.id });

    const updated = await updateWorkOrder({
      companyId: fixture.company.id,
      workOrderId: order.id,
      lines: [
        { description: "Revised", quantity: "1", rate: "25000", accountId: fixture.code("5000").id },
      ],
    });
    expect(updated.total.toFixed(2)).toBe("25000.00");
    // Nothing posted, so nothing to amend.
    expect(await prisma.journalEntry.count()).toBe(0);
  });

  it("leaves work orders from the old flow payable exactly as they were", async () => {
    const legacy = await draft();
    const { entry } = await approveAsLegacyWorkOrder(fixture.company.id, legacy.id, {
      userId: owner.id,
      role: "OWNER",
    });
    expect(entry).toBeTruthy();

    // Still a payable of its own, still settled by paying the work order.
    const open = await openDocumentsForVendor(fixture.company.id, consultant.id);
    expect(open).toHaveLength(1);
    expect(open[0].type).toBe("workOrder");

    await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: consultant.id,
      date: new Date("2026-07-26"),
      amount: "20000.00",
      currency: "PHP",
      paymentAccountId: fixture.code("1000").id,
      applications: [{ workOrderId: legacy.id, amountApplied: "20000.00" }],
      userId: owner.id,
    });

    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(after.status).toBe("PAID");
    expect(await balanceOf(fixture.system("ACCOUNTS_PAYABLE").id)).toBe("0.00");
  });
});
