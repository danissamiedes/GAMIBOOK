import { beforeEach, describe, expect, it } from "vitest";
import { recordExpense, voidExpense } from "@/lib/payables/expenses";
import { recordBillPayment } from "@/lib/payables/bill-payments";
import { completeReconciliation, openReconciliation, setAllCleared } from "@/lib/bank/reconcile";
import { trialBalance } from "@/lib/ledger/reports";
import { balancesByAccount } from "@/lib/reports/balances";
import { makeCompanyWithChart, makeUser, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

let fixture: Fixture;
let owner: Awaited<ReturnType<typeof makeUser>>;

const JULY = new Date("2025-07-10");
const YEAR_END = new Date("2025-12-31");

beforeEach(async () => {
  await resetDatabase();
  fixture = await makeCompanyWithChart("KASAGAMI APARTMENTS");
  owner = await makeUser("OWNER", fixture.company.id);
});

const spend = (date = JULY) =>
  recordExpense({
    companyId: fixture.company.id,
    kind: "DIRECT",
    date,
    currency: "PHP",
    amount: "10000.00",
    expenseAccountId: fixture.code("6100").id,
    paymentAccountId: fixture.code("1000").id,
    description: "Diesel",
    reference: "OR-5501",
    userId: owner.id,
    role: "OWNER",
  });

async function balanceOf(accountId: string) {
  const rows = await balancesByAccount({ companyId: fixture.company.id, to: YEAR_END });
  return rows.find((row) => row.accountId === accountId)?.amount.toFixed(2) ?? "0.00";
}

describe("voiding an expense (SPEC §8.2)", () => {
  it("keeps the document and reverses what it posted", async () => {
    const { expense } = await spend();
    expect(await balanceOf(fixture.code("6100").id)).toBe("10000.00");

    const voided = await voidExpense({
      companyId: fixture.company.id,
      expenseId: expense.id,
      date: JULY,
      userId: owner.id,
      role: "OWNER",
    });

    expect(voided.status).toBe("VOID");
    expect(voided.voidedAt).not.toBeNull();
    // Still on file, with everything it said.
    const after = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(after.description).toBe("Diesel");
    expect(after.reference).toBe("OR-5501");
    expect(after.amount.toFixed(2)).toBe("10000.00");

    // The accounts read as though it had never been recorded, and the books
    // still balance because the reversal is a posting of its own.
    expect(await balanceOf(fixture.code("6100").id)).toBe("0.00");
    const tb = await trialBalance({ companyId: fixture.company.id, asOf: YEAR_END });
    expect(tb.totalDebit.toFixed(2)).toBe(tb.totalCredit.toFixed(2));

    const entries = await prisma.journalEntry.findMany({
      where: { companyId: fixture.company.id, sourceType: "EXPENSE" },
      orderBy: { entryNumber: "asc" },
    });
    expect(entries).toHaveLength(2);
    // Dated to the expense, so July does not move.
    expect(entries[1].date.toISOString().slice(0, 10)).toBe("2025-07-10");
    expect(entries[0].reversedByEntryId).toBe(entries[1].id);
  });

  it("refuses one that is already void, and one with a payment on it", async () => {
    const { expense } = await spend();
    await voidExpense({
      companyId: fixture.company.id,
      expenseId: expense.id,
      date: JULY,
      userId: owner.id,
      role: "OWNER",
    });
    await expect(
      voidExpense({
        companyId: fixture.company.id,
        expenseId: expense.id,
        date: JULY,
        userId: owner.id,
        role: "OWNER",
      }),
    ).rejects.toThrow(/already void/i);

    const vendor = await prisma.vendor.create({
      data: {
        companyId: fixture.company.id,
        kind: "REGULAR",
        name: "DAVAO LIGHT",
        defaultCurrency: "PHP",
      },
    });
    const { expense: bill } = await recordExpense({
      companyId: fixture.company.id,
      kind: "BILL",
      vendorId: vendor.id,
      date: JULY,
      dueDate: JULY,
      currency: "PHP",
      amount: "5000.00",
      expenseAccountId: fixture.code("6100").id,
      description: "July electricity",
      reference: "DL-1",
      userId: owner.id,
      role: "OWNER",
    });
    await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: vendor.id,
      date: JULY,
      amount: "5000.00",
      currency: "PHP",
      paymentAccountId: fixture.code("1000").id,
      applications: [{ expenseId: bill.id, amountApplied: "5000.00" }],
      userId: owner.id,
    });

    await expect(
      voidExpense({
        companyId: fixture.company.id,
        expenseId: bill.id,
        date: JULY,
        userId: owner.id,
        role: "OWNER",
      }),
    ).rejects.toThrow(/payments applied/i);
  });

  it("refuses one whose entry was reconciled on a signed-off statement", async () => {
    const bankAccount = await prisma.bankAccount.create({
      data: {
        companyId: fixture.company.id,
        name: "Main",
        accountId: fixture.code("1000").id,
        currency: "PHP",
      },
    });
    const { expense } = await spend();

    const reconciliation = await openReconciliation({
      companyId: fixture.company.id,
      bankAccountId: bankAccount.id,
      statementDate: new Date("2025-07-31"),
      statementEndingBalance: "-10000.00",
      userId: owner.id,
    });
    await setAllCleared({
      companyId: fixture.company.id,
      reconciliationId: reconciliation.id,
      cleared: true,
    });
    await completeReconciliation({
      companyId: fixture.company.id,
      reconciliationId: reconciliation.id,
      userId: owner.id,
    });

    await expect(
      voidExpense({
        companyId: fixture.company.id,
        expenseId: expense.id,
        date: JULY,
        userId: owner.id,
        role: "OWNER",
      }),
    ).rejects.toThrow(/reconciled/i);

    // Nothing moved: the statement still means what it said.
    expect(await balanceOf(fixture.code("6100").id)).toBe("10000.00");
    const after = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(after.status).not.toBe("VOID");
  });

  it("refuses another company's expense, and a closed period for anyone but an owner", async () => {
    const { expense } = await spend();
    const other = await makeCompanyWithChart("THE PICKLE FARM");
    await expect(
      voidExpense({
        companyId: other.company.id,
        expenseId: expense.id,
        date: JULY,
        userId: owner.id,
        role: "OWNER",
      }),
    ).rejects.toThrow(/not found/i);

    await prisma.company.update({
      where: { id: fixture.company.id },
      data: { booksClosedThrough: new Date("2025-07-31") },
    });
    const bookkeeper = await makeUser("BOOKKEEPER", fixture.company.id);
    await expect(
      voidExpense({
        companyId: fixture.company.id,
        expenseId: expense.id,
        date: JULY,
        userId: bookkeeper.id,
        role: "BOOKKEEPER",
      }),
    ).rejects.toThrow(/books are closed/i);
  });
});
