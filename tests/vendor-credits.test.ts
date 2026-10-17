import { beforeEach, describe, expect, it } from "vitest";
import {
  applyVendorCredit,
  openBillsForCredit,
  recordVendorCredit,
  unapplyVendorCredit,
  voidVendorCredit,
} from "@/lib/payables/vendor-credits";
import { recordExpense } from "@/lib/payables/expenses";
import { recordBillPayment, openDocumentsForVendor } from "@/lib/payables/bill-payments";
import { apAging } from "@/lib/payables/aging";
import { trialBalance } from "@/lib/ledger/reports";
import { balancesByAccount } from "@/lib/reports/balances";
import { makeCompanyWithChart, makeUser, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

let fixture: Fixture;
let owner: Awaited<ReturnType<typeof makeUser>>;
let vendor: Awaited<ReturnType<typeof prisma.vendor.create>>;

const JULY = new Date("2026-07-10");
const YEAR_END = new Date("2026-12-31");

beforeEach(async () => {
  await resetDatabase();
  fixture = await makeCompanyWithChart("KASAGAMI APARTMENTS");
  owner = await makeUser("OWNER", fixture.company.id);
  vendor = await prisma.vendor.create({
    data: {
      companyId: fixture.company.id,
      kind: "REGULAR",
      name: "CARMEN COCO LUMBER",
      defaultCurrency: "PHP",
      paymentTermsDays: 30,
    },
  });
});

const bill = (amount: string, reference = "CCL-1") =>
  recordExpense({
    companyId: fixture.company.id,
    kind: "BILL",
    vendorId: vendor.id,
    date: JULY,
    dueDate: new Date("2026-08-09"),
    currency: "PHP",
    amount,
    expenseAccountId: fixture.code("6100").id,
    description: "Lumber",
    reference,
    userId: owner.id,
    role: "OWNER",
  });

const credit = (amount: string, reference = "CN-1") =>
  recordVendorCredit({
    companyId: fixture.company.id,
    vendorId: vendor.id,
    date: JULY,
    reference,
    currency: "PHP",
    amount,
    expenseAccountId: fixture.code("6100").id,
    memo: "Short delivery",
    userId: owner.id,
    role: "OWNER",
  });

const balanceOf = async (accountId: string) => {
  const rows = await balancesByAccount({ companyId: fixture.company.id, to: YEAR_END });
  return rows.find((row) => row.accountId === accountId)?.amount.toFixed(2) ?? "0.00";
};

describe("a credit note from a party (SPEC §8.5)", () => {
  it("posts the moment it is recorded: A/P down, the cost back out", async () => {
    await bill("10000.00");
    expect(await balanceOf(fixture.system("ACCOUNTS_PAYABLE").id)).toBe("10000.00");

    const { credit: note } = await credit("2500.00");

    expect(note.status).toBe("OPEN");
    expect(note.balance.toFixed(2)).toBe("2500.00");
    expect(await balanceOf(fixture.system("ACCOUNTS_PAYABLE").id)).toBe("7500.00");
    expect(await balanceOf(fixture.code("6100").id)).toBe("7500.00");
    const tb = await trialBalance({ companyId: fixture.company.id, asOf: YEAR_END });
    expect(tb.totalDebit.toFixed(2)).toBe(tb.totalCredit.toFixed(2));
  });

  it("refuses one with no reference, no amount, or against another company", async () => {
    await expect(credit("2500.00", "  ")).rejects.toThrow(/reference number is required/i);
    await expect(credit("0")).rejects.toThrow(/more than zero/i);

    const other = await makeCompanyWithChart("THE PICKLE FARM");
    await expect(
      recordVendorCredit({
        companyId: other.company.id,
        vendorId: vendor.id,
        date: JULY,
        reference: "CN-X",
        currency: "PHP",
        amount: "100.00",
        expenseAccountId: other.code("6100").id,
      }),
    ).rejects.toThrow(/party not found/i);
  });

  it("shows up in the aging before it is applied, so the report still ties", async () => {
    await bill("10000.00");
    await credit("2500.00");

    // Nothing has been applied, but A/P was debited the moment the credit was
    // recorded — so the aging has to know about it or it contradicts the
    // ledger it is supposed to be a breakdown of.
    const aging = await apAging({ companyId: fixture.company.id, asOf: YEAR_END });
    expect(aging.totals.total.toFixed(2)).toBe("7500.00");
    expect(await balanceOf(fixture.system("ACCOUNTS_PAYABLE").id)).toBe("7500.00");
    expect(aging.mismatchedVendors).toEqual([]);
    expect(aging.tiesToLedger).toBe(true);

    const credits = aging.rows[0].documents.filter((row) => row.type === "credit");
    expect(credits).toHaveLength(1);
    expect(credits[0].balanceDue.toFixed(2)).toBe("-2500.00");
  });

  it("applies to a bill without posting anything more", async () => {
    const { expense } = await bill("10000.00");
    const { credit: note } = await credit("2500.00");
    const entriesBefore = await prisma.journalEntry.count();

    const applied = await applyVendorCredit({
      companyId: fixture.company.id,
      vendorCreditId: note.id,
      applications: [{ expenseId: expense.id, amountApplied: "2500.00" }],
      userId: owner.id,
    });

    expect(applied.status).toBe("APPLIED");
    expect(applied.balance.toFixed(2)).toBe("0.00");
    // Applying moves no money, so it writes no entry.
    expect(await prisma.journalEntry.count()).toBe(entriesBefore);

    const after = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(after.creditedAmount.toFixed(2)).toBe("2500.00");
    expect(after.balanceDue.toFixed(2)).toBe("7500.00");
    // Credited is not paid: a bill settled by a credit was never paid.
    expect(after.amountPaid.toFixed(2)).toBe("0.00");
    expect(after.status).toBe("PARTIALLY_PAID");

    // And the aging agrees with the ledger.
    const aging = await apAging({ companyId: fixture.company.id, asOf: YEAR_END });
    expect(aging.totals.total.toFixed(2)).toBe("7500.00");
    expect(await balanceOf(fixture.system("ACCOUNTS_PAYABLE").id)).toBe("7500.00");
  });

  it("leaves the rest of the bill payable, and the payment settles it", async () => {
    const { expense } = await bill("10000.00");
    const { credit: note } = await credit("2500.00");
    await applyVendorCredit({
      companyId: fixture.company.id,
      vendorCreditId: note.id,
      applications: [{ expenseId: expense.id, amountApplied: "2500.00" }],
    });

    const open = await openDocumentsForVendor(fixture.company.id, vendor.id);
    expect(open).toHaveLength(1);
    expect(money(open[0].balanceDue)).toBe("7500.00");

    await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: vendor.id,
      date: new Date("2026-08-01"),
      amount: "7500.00",
      currency: "PHP",
      paymentAccountId: fixture.code("1000").id,
      applications: [{ expenseId: expense.id, amountApplied: "7500.00" }],
      userId: owner.id,
    });

    const settled = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(settled.status).toBe("PAID");
    expect(settled.balanceDue.toFixed(2)).toBe("0.00");
    expect(settled.amountPaid.toFixed(2)).toBe("7500.00");
    expect(settled.creditedAmount.toFixed(2)).toBe("2500.00");
    expect(await balanceOf(fixture.system("ACCOUNTS_PAYABLE").id)).toBe("0.00");
  });

  it("refuses more than the credit has, more than the bill owes, and another party's bill", async () => {
    const { expense } = await bill("1000.00");
    const { credit: note } = await credit("2500.00");

    await expect(
      applyVendorCredit({
        companyId: fixture.company.id,
        vendorCreditId: note.id,
        applications: [{ expenseId: expense.id, amountApplied: "1500.00" }],
      }),
    ).rejects.toThrow(/outstanding/i);

    const { credit: small } = await credit("100.00", "CN-2");
    await expect(
      applyVendorCredit({
        companyId: fixture.company.id,
        vendorCreditId: small.id,
        applications: [{ expenseId: expense.id, amountApplied: "500.00" }],
      }),
    ).rejects.toThrow(/has 100.00 left/i);

    const stranger = await prisma.vendor.create({
      data: {
        companyId: fixture.company.id,
        kind: "REGULAR",
        name: "SOMEBODY ELSE",
        defaultCurrency: "PHP",
      },
    });
    const { expense: theirs } = await recordExpense({
      companyId: fixture.company.id,
      kind: "BILL",
      vendorId: stranger.id,
      date: JULY,
      dueDate: JULY,
      currency: "PHP",
      amount: "500.00",
      expenseAccountId: fixture.code("6100").id,
      description: "Not ours",
      reference: "X-1",
    });
    await expect(
      applyVendorCredit({
        companyId: fixture.company.id,
        vendorCreditId: note.id,
        applications: [{ expenseId: theirs.id, amountApplied: "100.00" }],
      }),
    ).rejects.toThrow(/not this party's/i);
  });

  it("can be taken back off a bill, and then voided", async () => {
    const { expense } = await bill("10000.00");
    const { credit: note } = await credit("2500.00");
    await applyVendorCredit({
      companyId: fixture.company.id,
      vendorCreditId: note.id,
      applications: [{ expenseId: expense.id, amountApplied: "2500.00" }],
    });

    // While it is applied, voiding would leave the bill settled by nothing.
    await expect(
      voidVendorCredit({
        companyId: fixture.company.id,
        vendorCreditId: note.id,
        date: JULY,
      }),
    ).rejects.toThrow(/take it off that bill first/i);

    const application = await prisma.vendorCreditApplication.findFirstOrThrow({
      where: { vendorCreditId: note.id },
    });
    await unapplyVendorCredit({
      companyId: fixture.company.id,
      vendorCreditId: note.id,
      applicationId: application.id,
    });

    const reopened = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(reopened.creditedAmount.toFixed(2)).toBe("0.00");
    expect(reopened.balanceDue.toFixed(2)).toBe("10000.00");
    expect(reopened.status).toBe("APPROVED");

    const voided = await voidVendorCredit({
      companyId: fixture.company.id,
      vendorCreditId: note.id,
      date: JULY,
      userId: owner.id,
      role: "OWNER",
    });
    expect(voided.status).toBe("VOID");
    // The posting is reversed, so what is owed goes back up.
    expect(await balanceOf(fixture.system("ACCOUNTS_PAYABLE").id)).toBe("10000.00");
    const tb = await trialBalance({ companyId: fixture.company.id, asOf: YEAR_END });
    expect(tb.totalDebit.toFixed(2)).toBe(tb.totalCredit.toFixed(2));
  });

  it("lists the bills a credit could be set against", async () => {
    const { expense } = await bill("10000.00", "CCL-1");
    await bill("4000.00", "CCL-2");
    const open = await openBillsForCredit(fixture.company.id, vendor.id);
    expect(open).toHaveLength(2);
    expect(open.map((row) => row.id)).toContain(expense.id);
  });

  it("works for a consultant too", async () => {
    const consultant = await prisma.vendor.create({
      data: {
        companyId: fixture.company.id,
        kind: "CONSULTANT",
        name: "DANNY",
        defaultCurrency: "PHP",
      },
    });
    const { expense } = await recordExpense({
      companyId: fixture.company.id,
      kind: "BILL",
      vendorId: consultant.id,
      date: JULY,
      dueDate: JULY,
      currency: "PHP",
      amount: "8000.00",
      expenseAccountId: fixture.code("5000").id,
      description: "Overbilled days",
      reference: "WO1001",
    });
    const { credit: note } = await recordVendorCredit({
      companyId: fixture.company.id,
      vendorId: consultant.id,
      date: JULY,
      reference: "CN-C1",
      currency: "PHP",
      amount: "1000.00",
      expenseAccountId: fixture.code("5000").id,
    });
    await applyVendorCredit({
      companyId: fixture.company.id,
      vendorCreditId: note.id,
      applications: [{ expenseId: expense.id, amountApplied: "1000.00" }],
    });

    const after = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(after.balanceDue.toFixed(2)).toBe("7000.00");
  });
});

/** The decimal columns come back as Decimal; this keeps the assertions short. */
function money(value: { toFixed: (places: number) => string }) {
  return value.toFixed(2);
}
