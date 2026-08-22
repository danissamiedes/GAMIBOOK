import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  deleteExpense,
  recordExpense,
  whyNotDeletableExpense,
} from "@/lib/payables/expenses";
import { recordBillPayment } from "@/lib/payables/bill-payments";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { accountBalance } from "@/lib/ledger/reports";
import { closeBooksThrough } from "@/lib/periods/close";
import { makeCompanyWithChart, makeUser, makeVendor, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const DATE = new Date(Date.UTC(2026, 7, 15));
const AS_OF = new Date(Date.UTC(2026, 11, 31));

/**
 * SPEC §4.2 rule 3: posted entries are immutable, and same-day delete is the
 * one narrow exception. These tests care as much about what it refuses as
 * about what it does — and about the ledger landing back where it started.
 */
describe("deleting an expense recorded by mistake", () => {
  let fixture: Fixture;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let other: Awaited<ReturnType<typeof makeUser>>;
  let vendor: Awaited<ReturnType<typeof makeVendor>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Ledger Co", "PHP");
    owner = await makeUser("OWNER", fixture.company.id);
    other = await makeUser("BOOKKEEPER", fixture.company.id, "someone-else@example.test");
    vendor = await makeVendor(fixture.company.id, "REGULAR");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const balance = (code: string) =>
    accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.code(code).id,
      asOf: AS_OF,
    });

  const ap = () =>
    accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE).id,
      asOf: AS_OF,
    });

  const record = (kind: "DIRECT" | "BILL", userId = owner.id, amount = "1200.00") =>
    recordExpense({
      companyId: fixture.company.id,
      kind,
      date: DATE,
      currency: "PHP",
      amount,
      expenseAccountId: fixture.code("6000").id,
      paymentAccountId: kind === "DIRECT" ? fixture.code("1000").id : null,
      vendorId: kind === "BILL" ? vendor.id : null,
      description: "Paint",
      userId,
      role: "OWNER" as const,
    });

  const remove = (expenseId: string, userId = owner.id) =>
    deleteExpense({ companyId: fixture.company.id, expenseId, userId });

  it("erases a direct expense and puts the ledger back", async () => {
    const before = (await balance("6000")).toFixed(2);
    const { expense } = await record("DIRECT");
    expect((await balance("6000")).toFixed(2)).toBe("1200.00");

    await remove(expense.id);

    expect((await balance("6000")).toFixed(2)).toBe(before);
    expect((await balance("1000")).toFixed(2)).toBe("0.00");
    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.journalEntry.count()).toBe(0);
    expect(await prisma.journalLine.count()).toBe(0);
  });

  it("erases a bill and takes it out of accounts payable", async () => {
    const { expense } = await record("BILL");
    expect((await ap()).toFixed(2)).toBe("1200.00");

    await remove(expense.id);

    expect((await ap()).toFixed(2)).toBe("0.00");
    expect(await prisma.expense.count()).toBe(0);
  });

  it("keeps the whole document in the audit trail, and the entry number unused", async () => {
    const { expense, entry } = await record("DIRECT");
    await remove(expense.id);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "expense.deleted", entityId: expense.id },
    });
    const data = audit.data as {
      expense: { amount: string; description: string; date: string };
      entry: { entryNumber: number; lines: { debit: string; credit: string }[] };
    };
    expect(data.expense.amount).toBe("1200.00");
    expect(data.expense.description).toBe("Paint");
    expect(data.expense.date).toBe("2026-08-15");
    expect(data.entry.entryNumber).toBe(entry.entryNumber);
    expect(data.entry.lines).toHaveLength(2);
    expect(audit.summary).toContain("entry " + entry.entryNumber);

    // The gap is deliberate: the next entry takes the following number, and a
    // missing one is the thread an auditor pulls.
    const next = await record("DIRECT");
    expect(next.entry.entryNumber).toBe(entry.entryNumber + 1);
  });

  it("refuses a bill that has a payment applied", async () => {
    const { expense } = await record("BILL");
    await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: vendor.id,
      date: DATE,
      amount: "500.00",
      currency: "PHP",
      paymentAccountId: fixture.code("1000").id,
      applications: [{ expenseId: expense.id, amountApplied: "500.00" }],
      userId: owner.id,
      role: "OWNER",
    });

    await expect(remove(expense.id)).rejects.toThrow(/has payments applied/);
    expect(await prisma.expense.count()).toBe(1);
  });

  it("refuses someone else's expense", async () => {
    const { expense } = await record("DIRECT");
    await expect(remove(expense.id, other.id)).rejects.toThrow(
      /Only the person who recorded an? expense/,
    );
  });

  it("refuses an expense in a closed period", async () => {
    const { expense } = await record("DIRECT");
    await closeBooksThrough(
      { companyId: fixture.company.id, userId: owner.id, role: "OWNER" },
      new Date(Date.UTC(2026, 7, 31)),
    );

    await expect(remove(expense.id)).rejects.toThrow(/books are closed through 08\/31\/2026/);
    expect(await prisma.expense.count()).toBe(1);
  });

  /*
   * The 24-hour rule cannot be staged by ageing a posting: the immutability
   * trigger refuses that UPDATE, which is itself the right answer. So the
   * window is tested on the gate the delete asks — the same function the list
   * asks before it offers the button.
   */
  it("closes the window after 24 hours", () => {
    const gate = (postedAt: Date) =>
      whyNotDeletableExpense({
        expense: { kind: "DIRECT", voidedAt: null, createdAt: postedAt, applications: [] },
        entry: { postedAt, date: DATE, createdByUserId: "user-1", reversedByEntryId: null },
        postings: 1,
        bankMatchCount: 0,
        booksClosedThrough: null,
        userId: "user-1",
      });

    expect(gate(new Date())).toBeNull();
    expect(gate(new Date(Date.now() - 25 * 60 * 60 * 1000))).toMatch(/within 24 hours/);
  });

  it("calls a bill a bill when it refuses one", () => {
    const refusal = whyNotDeletableExpense({
      expense: { kind: "BILL", voidedAt: null, createdAt: new Date(), applications: [] },
      entry: null,
      postings: 0,
      bankMatchCount: 0,
      booksClosedThrough: null,
      userId: "user-1",
    });
    expect(refusal).toMatch(/No posting was found for this bill/);
  });

  it("refuses an expense from another company", async () => {
    const { expense } = await record("DIRECT");
    const elsewhere = await makeCompanyWithChart("Other Co", "PHP");

    await expect(
      deleteExpense({ companyId: elsewhere.company.id, expenseId: expense.id, userId: owner.id }),
    ).rejects.toThrow(/not found in this company/);
    expect(await prisma.expense.count()).toBe(1);
  });

  it("refuses a bank-matched expense", async () => {
    const { expense, entry } = await record("DIRECT");
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
        date: DATE,
        description: "PAINT SUPPLIES",
        amount: "-1200.00",
        status: "MATCHED",
        matchedJournalEntryId: entry.id,
        dedupeHash: "hash-1",
      },
    });

    await expect(remove(expense.id)).rejects.toThrow(/bank line is matched/);
  });

  it("puts an approved receipt back in the inbox rather than destroying it", async () => {
    const { expense } = await record("DIRECT");
    const receipt = await prisma.receiptUpload.create({
      data: {
        companyId: fixture.company.id,
        fileKey: "companies/x/inbox/y/receipt.png",
        filename: "receipt.png",
        mimeType: "image/png",
        byteSize: 1024,
        status: "APPROVED",
        expenseId: expense.id,
      },
    });

    await remove(expense.id);

    const after = await prisma.receiptUpload.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(after.status).toBe("READY");
    expect(after.expenseId).toBeNull();
  });

  it("cannot be got around by deleting the entry directly", async () => {
    const { entry } = await record("DIRECT");
    await expect(prisma.journalEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
      /immutable/,
    );
  });
});
