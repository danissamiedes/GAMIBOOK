import { beforeEach, describe, expect, it } from "vitest";
import {
  findReclassifiableLines,
  listReclassifications,
  reclassifyLines,
  reverseReclassification,
} from "@/lib/ledger/reclassify";
import { postJournalEntry } from "@/lib/ledger/post";
import { completeReconciliation, openReconciliation, setAllCleared } from "@/lib/bank/reconcile";
import { trialBalance } from "@/lib/ledger/reports";
import { balancesByAccount } from "@/lib/reports/balances";
import { recordExpense } from "@/lib/payables/expenses";
import { makeCompanyWithChart, makeUser, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

let fixture: Fixture;
/** 6100 Supplies — where the fuel was wrongly coded. */
let wrong: { id: string; code: string };
/** 6200 — where it belongs. */
let right: { id: string; code: string };
let cash: { id: string };

const JULY = new Date("2025-07-15");
const AUGUST = new Date("2025-08-20");
const YEAR_END = new Date("2025-12-31");

beforeEach(async () => {
  await resetDatabase();
  fixture = await makeCompanyWithChart("KASAGAMI APARTMENTS");
  wrong = fixture.code("6100");
  right = fixture.code("6200");
  cash = fixture.code("1010");
});

/** A posting of `amount` into the wrong account, paid from cash. */
async function spend(amount: string, date = JULY, description = "Diesel") {
  const { expense } = await recordExpense({
    companyId: fixture.company.id,
    kind: "DIRECT",
    date,
    currency: "PHP",
    amount,
    expenseAccountId: wrong.id,
    paymentAccountId: cash.id,
    description,
    reference: "PO-7781",
  });
  return expense;
}

/** The single line sitting in `accountId`, as the picker would find it. */
async function lineIn(accountId: string, description?: string) {
  const line = await prisma.journalLine.findFirstOrThrow({
    where: {
      accountId,
      entry: { companyId: fixture.company.id },
      ...(description ? { description } : {}),
    },
    orderBy: { id: "asc" },
  });
  return line;
}

async function balanceOf(accountId: string) {
  const rows = await balancesByAccount({ companyId: fixture.company.id, to: YEAR_END });
  return rows.find((row) => row.accountId === accountId)?.amount.toFixed(2) ?? "0.00";
}

describe("finding what to move (SPEC §18)", () => {
  it("lists the account's postings for the period, with the document's reference", async () => {
    await spend("10000.00", JULY);
    await spend("2500.00", AUGUST, "Oil");

    const found = await findReclassifiableLines({
      companyId: fixture.company.id,
      accountId: wrong.id,
      from: new Date("2025-07-01"),
      to: new Date("2025-07-31"),
    });

    expect(found.lines).toHaveLength(1);
    expect(found.lines[0]).toMatchObject({ reference: "PO-7781", description: "Diesel" });
    expect(found.lines[0].debit.toFixed(2)).toBe("10000.00");
    expect(found.lines[0].credit.toFixed(2)).toBe("0.00");
    expect(found.lines[0].blockedReason).toBeNull();
  });

  it("filters by description and by the kind of document", async () => {
    await spend("10000.00", JULY, "Diesel");
    await spend("900.00", JULY, "Stationery");

    const byDescription = await findReclassifiableLines({
      companyId: fixture.company.id,
      accountId: wrong.id,
      from: new Date("2025-07-01"),
      to: new Date("2025-07-31"),
      description: "diesel",
    });
    expect(byDescription.lines.map((line) => line.description)).toEqual(["Diesel"]);

    const byType = await findReclassifiableLines({
      companyId: fixture.company.id,
      accountId: wrong.id,
      from: new Date("2025-07-01"),
      to: new Date("2025-07-31"),
      sourceType: "INVOICE",
    });
    expect(byType.lines).toEqual([]);
  });

  it("shows a posting that cannot be moved, and says why", async () => {
    const expense = await spend("10000.00");
    const line = await lineIn(wrong.id);
    await reclassifyLines({
      companyId: fixture.company.id,
      fromAccountId: wrong.id,
      toAccountId: right.id,
      journalLineIds: [line.id],
    });
    expect(expense).toBeTruthy();

    const found = await findReclassifiableLines({
      companyId: fixture.company.id,
      accountId: wrong.id,
      from: new Date("2025-07-01"),
      to: new Date("2025-07-31"),
    });
    const original = found.lines.find((row) => row.journalLineId === line.id);
    expect(original?.blockedReason).toMatch(/Already moved to 6200/);
  });
});

describe("moving the postings (SPEC §18)", () => {
  it("takes the amount out of one account and puts it in the other", async () => {
    await spend("10000.00");
    const line = await lineIn(wrong.id);

    const result = await reclassifyLines({
      companyId: fixture.company.id,
      fromAccountId: wrong.id,
      toAccountId: right.id,
      journalLineIds: [line.id],
      reason: "Fuel miscoded to Supplies",
    });

    expect(result.movedCount).toBe(1);
    expect(result.totalDebit.toFixed(2)).toBe("10000.00");

    // The books still balance, and the two accounts now read correctly.
    const tb = await trialBalance({ companyId: fixture.company.id, asOf: YEAR_END });
    expect(tb.totalDebit.toFixed(2)).toBe(tb.totalCredit.toFixed(2));
    expect(await balanceOf(wrong.id)).toBe("0.00");
    expect(await balanceOf(right.id)).toBe("10000.00");

    // The correcting entry debits the destination and credits the source.
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: fixture.company.id, sourceType: "RECLASSIFICATION" },
      include: { lines: { orderBy: { lineNumber: "asc" } } },
    });
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines[0]).toMatchObject({ accountId: right.id });
    expect(entry.lines[0].debit.toFixed(2)).toBe("10000.00");
    expect(entry.lines[1]).toMatchObject({ accountId: wrong.id });
    expect(entry.lines[1].credit.toFixed(2)).toBe("10000.00");
    expect(entry.memo).toMatch(/Fuel miscoded to Supplies/);
    // It is dated to the posting it corrects, not to today.
    expect(entry.date.toISOString().slice(0, 10)).toBe("2025-07-15");
  });

  it("moves a credit the way it was posted, not as a debit", async () => {
    // A credit sitting in an expense account — a refund, booked the wrong way.
    await postJournalEntry({
      companyId: fixture.company.id,
      date: JULY,
      memo: "Supplier refund",
      sourceType: "MANUAL",
      lines: [
        { accountId: cash.id, debit: "1500.00", description: "Refund received" },
        { accountId: wrong.id, credit: "1500.00", description: "Refund received" },
      ],
    });
    const line = await lineIn(wrong.id, "Refund received");

    await reclassifyLines({
      companyId: fixture.company.id,
      fromAccountId: wrong.id,
      toAccountId: right.id,
      journalLineIds: [line.id],
    });

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: fixture.company.id, sourceType: "RECLASSIFICATION" },
      include: { lines: { orderBy: { lineNumber: "asc" } } },
    });
    // The destination takes the credit; the source gets the debit back.
    expect(entry.lines[0].accountId).toBe(right.id);
    expect(entry.lines[0].credit.toFixed(2)).toBe("1500.00");
    expect(entry.lines[1].accountId).toBe(wrong.id);
    expect(entry.lines[1].debit.toFixed(2)).toBe("1500.00");
    expect(await balanceOf(wrong.id)).toBe("0.00");
    expect(await balanceOf(right.id)).toBe("-1500.00");
  });

  it("moves a batch of postings in one act, and leaves the originals alone", async () => {
    await spend("10000.00", JULY, "Diesel");
    await spend("2500.00", AUGUST, "Oil");
    const lines = await prisma.journalLine.findMany({
      where: { accountId: wrong.id, entry: { companyId: fixture.company.id } },
      orderBy: { id: "asc" },
    });

    const result = await reclassifyLines({
      companyId: fixture.company.id,
      fromAccountId: wrong.id,
      toAccountId: right.id,
      journalLineIds: lines.map((line) => line.id),
      reason: "Q3 fuel",
    });
    expect(result.movedCount).toBe(2);

    // Each correcting entry carries the date of the posting it corrects.
    const entries = await prisma.journalEntry.findMany({
      where: { companyId: fixture.company.id, sourceType: "RECLASSIFICATION" },
      orderBy: { date: "asc" },
    });
    expect(entries.map((entry) => entry.date.toISOString().slice(0, 10))).toEqual([
      "2025-07-15",
      "2025-08-20",
    ]);

    // The originals are exactly as they were, and each is linked to its entry.
    const after = await prisma.journalLine.findMany({
      where: { id: { in: lines.map((line) => line.id) } },
      orderBy: { id: "asc" },
    });
    expect(after.map((line) => line.accountId)).toEqual(lines.map(() => wrong.id));
    expect(after.map((line) => line.debit.toFixed(2))).toEqual(
      lines.map((line) => line.debit.toFixed(2)),
    );

    const record = await prisma.reclassification.findUniqueOrThrow({
      where: { id: result.reclassificationId },
      include: { lines: true },
    });
    expect(record.lines.map((line) => line.sourceJournalLineId).sort()).toEqual(
      lines.map((line) => line.id).sort(),
    );
    expect(record.reason).toBe("Q3 fuel");

    const audit = await prisma.auditLog.findFirst({
      where: { companyId: fixture.company.id, action: "reclassification.posted" },
    });
    expect(audit?.summary).toMatch(/2 postings moved from 6100/);
  });

  it("posts the whole batch on one date when asked", async () => {
    await spend("10000.00", JULY);
    await spend("2500.00", AUGUST, "Oil");
    const lines = await prisma.journalLine.findMany({
      where: { accountId: wrong.id, entry: { companyId: fixture.company.id } },
    });

    await reclassifyLines({
      companyId: fixture.company.id,
      fromAccountId: wrong.id,
      toAccountId: right.id,
      journalLineIds: lines.map((line) => line.id),
      date: new Date("2025-09-30"),
    });

    const entries = await prisma.journalEntry.findMany({
      where: { companyId: fixture.company.id, sourceType: "RECLASSIFICATION" },
    });
    expect(
      entries.every((entry) => entry.date.toISOString().slice(0, 10) === "2025-09-30"),
    ).toBe(true);
  });
});

describe("what is refused (SPEC §18)", () => {
  it("refuses an empty selection and a destination that is the source", async () => {
    await expect(
      reclassifyLines({
        companyId: fixture.company.id,
        fromAccountId: wrong.id,
        toAccountId: right.id,
        journalLineIds: [],
      }),
    ).rejects.toThrow(/at least one/i);

    await spend("10000.00");
    const line = await lineIn(wrong.id);
    await expect(
      reclassifyLines({
        companyId: fixture.company.id,
        fromAccountId: wrong.id,
        toAccountId: wrong.id,
        journalLineIds: [line.id],
      }),
    ).rejects.toThrow(/must be different/i);
  });

  it("refuses a posting that is not in the source account", async () => {
    await spend("10000.00");
    const cashLine = await lineIn(cash.id);

    await expect(
      reclassifyLines({
        companyId: fixture.company.id,
        fromAccountId: wrong.id,
        toAccountId: right.id,
        journalLineIds: [cashLine.id],
      }),
    ).rejects.toThrow(/no longer in that account/i);
    expect(await prisma.reclassification.count()).toBe(0);
  });

  it("refuses another company's posting", async () => {
    const other = await makeCompanyWithChart("THE PICKLE FARM");
    const { expense } = await recordExpense({
      companyId: other.company.id,
      kind: "DIRECT",
      date: JULY,
      currency: "PHP",
      amount: "500.00",
      expenseAccountId: other.code("6100").id,
      paymentAccountId: other.code("1010").id,
      description: "Not ours",
    });
    expect(expense.companyId).toBe(other.company.id);
    const theirs = await prisma.journalLine.findFirstOrThrow({
      where: { accountId: other.code("6100").id },
    });

    await expect(
      reclassifyLines({
        companyId: fixture.company.id,
        fromAccountId: wrong.id,
        toAccountId: right.id,
        journalLineIds: [theirs.id],
      }),
    ).rejects.toThrow(/no longer in that account/i);
  });

  it("refuses the same posting twice, which is what a double click is", async () => {
    await spend("10000.00");
    const line = await lineIn(wrong.id);
    const once = {
      companyId: fixture.company.id,
      fromAccountId: wrong.id,
      toAccountId: right.id,
      journalLineIds: [line.id],
    };
    await reclassifyLines(once);
    await expect(reclassifyLines(once)).rejects.toThrow(/already been reclassified/i);

    expect(
      await prisma.journalEntry.count({
        where: { companyId: fixture.company.id, sourceType: "RECLASSIFICATION" },
      }),
    ).toBe(1);
  });

  it("refuses the ledger's own control accounts", async () => {
    await spend("10000.00");
    const line = await lineIn(wrong.id);
    await expect(
      reclassifyLines({
        companyId: fixture.company.id,
        fromAccountId: wrong.id,
        toAccountId: fixture.system("ACCOUNTS_PAYABLE").id,
        journalLineIds: [line.id],
      }),
    ).rejects.toThrow(/System accounts/i);
  });

  it("refuses a posting whose entry has been reversed", async () => {
    await spend("10000.00");
    const line = await lineIn(wrong.id);
    const { reverseJournalEntry } = await import("@/lib/ledger/post");
    await reverseJournalEntry({
      companyId: fixture.company.id,
      entryId: line.journalEntryId,
      date: AUGUST,
    });

    await expect(
      reclassifyLines({
        companyId: fixture.company.id,
        fromAccountId: wrong.id,
        toAccountId: right.id,
        journalLineIds: [line.id],
      }),
    ).rejects.toThrow(/reversed/i);
  });

  it("refuses the batch when one posting falls in a closed period, and posts none of it", async () => {
    await spend("10000.00", JULY);
    await spend("2500.00", AUGUST, "Oil");
    await prisma.company.update({
      where: { id: fixture.company.id },
      data: { booksClosedThrough: new Date("2025-07-31") },
    });
    const lines = await prisma.journalLine.findMany({
      where: { accountId: wrong.id, entry: { companyId: fixture.company.id } },
    });

    const user = await makeUser("BOOKKEEPER", fixture.company.id);
    await expect(
      reclassifyLines({
        companyId: fixture.company.id,
        fromAccountId: wrong.id,
        toAccountId: right.id,
        journalLineIds: lines.map((line) => line.id),
        userId: user.id,
        role: "BOOKKEEPER",
      }),
    ).rejects.toThrow(/books are closed/i);

    // Nothing at all: not the August one that would have been allowed.
    expect(
      await prisma.journalEntry.count({
        where: { companyId: fixture.company.id, sourceType: "RECLASSIFICATION" },
      }),
    ).toBe(0);
    expect(await prisma.reclassification.count()).toBe(0);
    expect(await balanceOf(right.id)).toBe("0.00");
  });

  it("lets an owner move a posting in a closed period", async () => {
    await spend("10000.00", JULY);
    await prisma.company.update({
      where: { id: fixture.company.id },
      data: { booksClosedThrough: new Date("2025-07-31") },
    });
    const line = await lineIn(wrong.id);
    const owner = await makeUser("OWNER", fixture.company.id);

    const result = await reclassifyLines({
      companyId: fixture.company.id,
      fromAccountId: wrong.id,
      toAccountId: right.id,
      journalLineIds: [line.id],
      userId: owner.id,
      role: "OWNER",
    });
    expect(result.movedCount).toBe(1);
  });

  it("refuses a posting that has been reconciled on a signed-off statement", async () => {
    // The statement is what makes this different from any other posting: the
    // cash line has been ticked off against a bank statement somebody signed.
    const owner = await makeUser("OWNER", fixture.company.id);
    const bankAccount = await prisma.bankAccount.create({
      data: {
        companyId: fixture.company.id,
        name: "Main",
        accountId: fixture.code("1000").id,
        currency: "PHP",
      },
    });
    await postJournalEntry({
      companyId: fixture.company.id,
      date: JULY,
      memo: "Deposit",
      sourceType: "MANUAL",
      userId: owner.id,
      role: "OWNER",
      lines: [
        { accountId: fixture.code("1000").id, debit: "5000.00", description: "Deposit" },
        { accountId: fixture.code("4000").id, credit: "5000.00", description: "Deposit" },
      ],
    });
    const reconciliation = await openReconciliation({
      companyId: fixture.company.id,
      bankAccountId: bankAccount.id,
      statementDate: new Date("2025-07-31"),
      statementEndingBalance: "5000.00",
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

    const bankLine = await lineIn(fixture.code("1000").id, "Deposit");
    await expect(
      reclassifyLines({
        companyId: fixture.company.id,
        fromAccountId: fixture.code("1000").id,
        toAccountId: fixture.code("1010").id,
        journalLineIds: [bankLine.id],
        userId: owner.id,
        role: "OWNER",
      }),
    ).rejects.toThrow(/reconciled/i);

    // And the picker says so in place, rather than hiding the row.
    const found = await findReclassifiableLines({
      companyId: fixture.company.id,
      accountId: fixture.code("1000").id,
      from: new Date("2025-07-01"),
      to: new Date("2025-07-31"),
    });
    expect(found.lines[0].blockedReason).toMatch(/Reconciled on the statement/);
  });
});

describe("reversing a reclassification (SPEC §18)", () => {
  it("puts the postings back, and frees them to be moved again", async () => {
    await spend("10000.00");
    const line = await lineIn(wrong.id);
    const posted = await reclassifyLines({
      companyId: fixture.company.id,
      fromAccountId: wrong.id,
      toAccountId: right.id,
      journalLineIds: [line.id],
    });

    const undone = await reverseReclassification({
      companyId: fixture.company.id,
      reclassificationId: posted.reclassificationId,
    });
    expect(undone.reversedCount).toBe(1);

    // Back where it started, and the books still balance.
    expect(await balanceOf(wrong.id)).toBe("10000.00");
    expect(await balanceOf(right.id)).toBe("0.00");
    const tb = await trialBalance({ companyId: fixture.company.id, asOf: YEAR_END });
    expect(tb.totalDebit.toFixed(2)).toBe(tb.totalCredit.toFixed(2));

    // The record of what happened stays, with the reversing entry on it.
    const record = await prisma.reclassification.findUniqueOrThrow({
      where: { id: posted.reclassificationId },
      include: { lines: true },
    });
    expect(record.reversedAt).not.toBeNull();
    expect(record.lines[0].reversalEntryId).not.toBeNull();
    expect(record.lines[0].activeSourceLineId).toBeNull();

    // And the original posting can be moved somewhere else now.
    const again = await reclassifyLines({
      companyId: fixture.company.id,
      fromAccountId: wrong.id,
      toAccountId: fixture.code("6300").id,
      journalLineIds: [line.id],
    });
    expect(again.movedCount).toBe(1);
    expect(await balanceOf(fixture.code("6300").id)).toBe("10000.00");
  });

  it("refuses to reverse the same batch twice", async () => {
    await spend("10000.00");
    const line = await lineIn(wrong.id);
    const posted = await reclassifyLines({
      companyId: fixture.company.id,
      fromAccountId: wrong.id,
      toAccountId: right.id,
      journalLineIds: [line.id],
    });
    await reverseReclassification({
      companyId: fixture.company.id,
      reclassificationId: posted.reclassificationId,
    });
    await expect(
      reverseReclassification({
        companyId: fixture.company.id,
        reclassificationId: posted.reclassificationId,
      }),
    ).rejects.toThrow(/already been reversed/i);
  });

  it("will not reverse another company's batch", async () => {
    await spend("10000.00");
    const line = await lineIn(wrong.id);
    const posted = await reclassifyLines({
      companyId: fixture.company.id,
      fromAccountId: wrong.id,
      toAccountId: right.id,
      journalLineIds: [line.id],
    });
    const other = await makeCompanyWithChart("THE PICKLE FARM");

    await expect(
      reverseReclassification({
        companyId: other.company.id,
        reclassificationId: posted.reclassificationId,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("keeps the history, newest first", async () => {
    await spend("10000.00", JULY);
    await spend("2500.00", AUGUST, "Oil");
    const [first, second] = await prisma.journalLine.findMany({
      where: { accountId: wrong.id, entry: { companyId: fixture.company.id } },
      orderBy: { entry: { date: "asc" } },
    });
    await reclassifyLines({
      companyId: fixture.company.id,
      fromAccountId: wrong.id,
      toAccountId: right.id,
      journalLineIds: [first.id],
      reason: "July",
    });
    await reclassifyLines({
      companyId: fixture.company.id,
      fromAccountId: wrong.id,
      toAccountId: right.id,
      journalLineIds: [second.id],
      reason: "August",
    });

    const history = await listReclassifications(fixture.company.id);
    expect(history).toHaveLength(2);
    expect(history[0].reason).toBe("August");
    expect(history[0].toAccount.code).toBe("6200");
  });
});
