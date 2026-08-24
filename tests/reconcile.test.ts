import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  completeReconciliation,
  openReconciliation,
  openingBalanceFor,
  reconciliationView,
  reopenReconciliation,
  setAllCleared,
  setLineCleared,
} from "@/lib/bank/reconcile";
import { postJournalEntry } from "@/lib/ledger/post";
import { deleteExpense, recordExpense, updateExpense } from "@/lib/payables/expenses";
import { makeCompanyWithChart, makeUser, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const AUGUST_31 = new Date(Date.UTC(2026, 7, 31));

/**
 * Bank reconciliation (SPEC §8.4a).
 *
 * The arithmetic is the feature, so most of this is arithmetic. The rest is the
 * lock: a signed-off statement whose lines can still be edited or deleted
 * afterwards proves nothing, and that guarantee is worth more tests than the
 * happy path.
 */
describe("bank reconciliation", () => {
  let fixture: Fixture;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let bankAccount: Awaited<ReturnType<typeof prisma.bankAccount.create>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Ledger Co", "PHP");
    owner = await makeUser("OWNER", fixture.company.id);
    bankAccount = await prisma.bankAccount.create({
      data: {
        companyId: fixture.company.id,
        name: "Main",
        accountId: fixture.code("1000").id,
        currency: "PHP",
      },
    });
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  /** Money into (positive) or out of (negative) the bank, on a date. */
  async function bankEntry(amount: string, day: number, memo = "Movement") {
    const into = !amount.startsWith("-");
    const size = amount.replace("-", "");
    return postJournalEntry({
      companyId: fixture.company.id,
      date: new Date(Date.UTC(2026, 7, day)),
      memo,
      sourceType: "MANUAL",
      userId: owner.id,
      role: "OWNER",
      lines: into
        ? [
            { accountId: fixture.code("1000").id, debit: size },
            { accountId: fixture.code("4000").id, credit: size },
          ]
        : [
            { accountId: fixture.code("6000").id, debit: size },
            { accountId: fixture.code("1000").id, credit: size },
          ],
    });
  }

  const start = (ending: string, date = AUGUST_31) =>
    openReconciliation({
      companyId: fixture.company.id,
      bankAccountId: bankAccount.id,
      statementDate: date,
      statementEndingBalance: ending,
      userId: owner.id,
    });

  const view = (id: string) =>
    reconciliationView({ companyId: fixture.company.id, reconciliationId: id });

  const tick = (id: string, lineId: string, cleared = true) =>
    setLineCleared({
      companyId: fixture.company.id,
      reconciliationId: id,
      journalLineId: lineId,
      cleared,
    });

  /** The bank-side line of an entry, which is the one that reconciles. */
  const bankLine = (entry: { lines: { accountId: string; id: string }[] }) =>
    entry.lines.find((line) => line.accountId === fixture.code("1000").id)!.id;

  describe("the arithmetic", () => {
    it("starts at zero and shows every line as outstanding", async () => {
      await bankEntry("1000.00", 5);
      await bankEntry("-250.00", 10);
      const rec = await start("750.00");

      const state = await view(rec.id);
      expect(state.lines).toHaveLength(2);
      expect(state.lines.every((line) => !line.cleared)).toBe(true);
      expect(state.clearedTotal.toFixed(2)).toBe("0.00");
      expect(state.outstandingTotal.toFixed(2)).toBe("750.00");
      // Nothing ticked yet, so the whole statement is unexplained.
      expect(state.difference.toFixed(2)).toBe("750.00");
      expect(state.balanced).toBe(false);
    });

    it("closes the difference as lines are ticked", async () => {
      const into = await bankEntry("1000.00", 5);
      const out = await bankEntry("-250.00", 10);
      const rec = await start("750.00");

      await tick(rec.id, bankLine(into));
      expect((await view(rec.id)).difference.toFixed(2)).toBe("-250.00");

      await tick(rec.id, bankLine(out));
      const state = await view(rec.id);
      expect(state.clearedTotal.toFixed(2)).toBe("750.00");
      expect(state.difference.toFixed(2)).toBe("0.00");
      expect(state.balanced).toBe(true);
    });

    it("leaves an uncashed cheque outstanding, and the difference explains it", async () => {
      const into = await bankEntry("1000.00", 5);
      await bankEntry("-250.00", 10, "Cheque 001, not yet presented");
      // The bank has not seen the cheque, so it says 1000.
      const rec = await start("1000.00");

      await tick(rec.id, bankLine(into));
      const state = await view(rec.id);
      expect(state.balanced).toBe(true);
      // This is the number reconciliation exists to produce.
      expect(state.outstandingTotal.toFixed(2)).toBe("-250.00");
    });

    it("ignores entries dated after the statement closes", async () => {
      await bankEntry("1000.00", 5);
      await bankEntry("500.00", 31);
      // September's movement is not on August's statement.
      await bankEntry("999.00", 40);

      const rec = await start("1500.00");
      const state = await view(rec.id);
      expect(state.lines).toHaveLength(2);
      await setAllCleared({
        companyId: fixture.company.id,
        reconciliationId: rec.id,
        cleared: true,
      });
      expect((await view(rec.id)).balanced).toBe(true);
    });

    it("ticks and unticks everything at once", async () => {
      await bankEntry("1000.00", 5);
      await bankEntry("-250.00", 10);
      const rec = await start("750.00");

      await setAllCleared({ companyId: fixture.company.id, reconciliationId: rec.id, cleared: true });
      expect((await view(rec.id)).balanced).toBe(true);

      await setAllCleared({
        companyId: fixture.company.id,
        reconciliationId: rec.id,
        cleared: false,
      });
      expect((await view(rec.id)).clearedTotal.toFixed(2)).toBe("0.00");
    });

    it("carries the signed-off balance into the next statement", async () => {
      const into = await bankEntry("1000.00", 5);
      const first = await start("1000.00");
      await tick(first.id, bankLine(into));
      await completeReconciliation({
        companyId: fixture.company.id,
        reconciliationId: first.id,
        userId: owner.id,
      });

      await bankEntry("400.00", 40);
      const second = await start("1400.00", new Date(Date.UTC(2026, 8, 30)));
      const state = await view(second.id);

      expect(state.reconciliation.openingBalance.toFixed(2)).toBe("1000.00");
      // The line cleared in August is settled business and does not come back.
      expect(state.lines).toHaveLength(1);
      expect(state.difference.toFixed(2)).toBe("400.00");
    });
  });

  describe("finishing", () => {
    it("refuses while the difference is not zero", async () => {
      await bankEntry("1000.00", 5);
      const rec = await start("750.00");

      await expect(
        completeReconciliation({
          companyId: fixture.company.id,
          reconciliationId: rec.id,
          userId: owner.id,
        }),
      ).rejects.toThrow(/difference is 750.00, not zero/);
    });

    it("signs off and records what balanced", async () => {
      const into = await bankEntry("1000.00", 5);
      const rec = await start("1000.00");
      await tick(rec.id, bankLine(into));

      const done = await completeReconciliation({
        companyId: fixture.company.id,
        reconciliationId: rec.id,
        userId: owner.id,
      });
      expect(done.status).toBe("COMPLETED");
      expect(done.completedAt).toBeTruthy();

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "reconciliation.completed" },
      });
      expect(audit.summary).toContain("08/31/2026");
      expect((audit.data as { clearedTotal: string }).clearedTotal).toBe("1000.00");
    });

    it("refuses to start a second statement ending on or before a signed-off one", async () => {
      const into = await bankEntry("1000.00", 5);
      const rec = await start("1000.00");
      await tick(rec.id, bankLine(into));
      await completeReconciliation({
        companyId: fixture.company.id,
        reconciliationId: rec.id,
        userId: owner.id,
      });

      await expect(start("1000.00", new Date(Date.UTC(2026, 7, 15)))).rejects.toThrow(
        /already reconciled through 08\/31\/2026/,
      );
    });

    it("joins the reconciliation already open rather than starting a rival", async () => {
      await bankEntry("1000.00", 5);
      const first = await start("1000.00");
      const second = await start("1200.00");

      expect(second.id).toBe(first.id);
      // The statement it is against can still be corrected while it is open.
      expect(second.statementEndingBalance.toFixed(2)).toBe("1200.00");
      expect(await prisma.bankReconciliation.count()).toBe(1);
    });
  });

  describe("the lock a sign-off buys", () => {
    async function reconciledExpense() {
      const { expense, entry } = await recordExpense({
        companyId: fixture.company.id,
        kind: "DIRECT",
        date: new Date(Date.UTC(2026, 7, 10)),
        currency: "PHP",
        amount: "250.00",
        expenseAccountId: fixture.code("6000").id,
        paymentAccountId: fixture.code("1000").id,
        description: "Paint",
        userId: owner.id,
        role: "OWNER",
      });

      const rec = await start("-250.00");
      const lines = await prisma.journalLine.findMany({
        where: { journalEntryId: entry.id, accountId: fixture.code("1000").id },
      });
      await tick(rec.id, lines[0].id);
      await completeReconciliation({
        companyId: fixture.company.id,
        reconciliationId: rec.id,
        userId: owner.id,
      });
      return { expense, rec };
    }

    it("refuses to edit a reconciled entry", async () => {
      const { expense } = await reconciledExpense();

      // The amend reverses back to the original date, which would change the
      // balance of a statement someone has already signed off.
      await expect(
        updateExpense({
          companyId: fixture.company.id,
          expenseId: expense.id,
          date: new Date(Date.UTC(2026, 7, 10)),
          currency: "PHP",
          amount: "300.00",
          expenseAccountId: fixture.code("6000").id,
          paymentAccountId: fixture.code("1000").id,
          description: "Paint",
          userId: owner.id,
          role: "OWNER",
        }),
      ).rejects.toThrow(/reconciled on the statement to 08\/31\/2026/);
    });

    it("refuses to delete a reconciled entry", async () => {
      const { expense } = await reconciledExpense();

      await expect(
        deleteExpense({
          companyId: fixture.company.id,
          expenseId: expense.id,
          userId: owner.id,
        }),
      ).rejects.toThrow(/reconciled on the statement/);
      expect(await prisma.expense.count()).toBe(1);
    });

    it("lets both through again once the reconciliation is reopened", async () => {
      const { expense, rec } = await reconciledExpense();
      await reopenReconciliation({
        companyId: fixture.company.id,
        reconciliationId: rec.id,
        userId: owner.id,
      });

      const updated = await updateExpense({
        companyId: fixture.company.id,
        expenseId: expense.id,
        date: new Date(Date.UTC(2026, 7, 10)),
        currency: "PHP",
        amount: "300.00",
        expenseAccountId: fixture.code("6000").id,
        paymentAccountId: fixture.code("1000").id,
        description: "Paint",
        userId: owner.id,
        role: "OWNER",
      });
      expect(updated.expense.amount.toFixed(2)).toBe("300.00");
    });

    it("does not lock anything while the reconciliation is still open", async () => {
      const { expense } = await recordExpense({
        companyId: fixture.company.id,
        kind: "DIRECT",
        date: new Date(Date.UTC(2026, 7, 10)),
        currency: "PHP",
        amount: "250.00",
        expenseAccountId: fixture.code("6000").id,
        paymentAccountId: fixture.code("1000").id,
        description: "Paint",
        userId: owner.id,
        role: "OWNER",
      });
      const rec = await start("-250.00");
      const state = await view(rec.id);
      await tick(rec.id, state.lines[0].lineId);

      // Ticked but not signed off: still ordinary, still editable.
      const updated = await updateExpense({
        companyId: fixture.company.id,
        expenseId: expense.id,
        date: new Date(Date.UTC(2026, 7, 10)),
        currency: "PHP",
        amount: "300.00",
        expenseAccountId: fixture.code("6000").id,
        paymentAccountId: fixture.code("1000").id,
        description: "Paint",
        userId: owner.id,
        role: "OWNER",
      });
      expect(updated.expense.amount.toFixed(2)).toBe("300.00");
    });
  });

  describe("reopening", () => {
    it("refuses one that is not finished", async () => {
      await bankEntry("1000.00", 5);
      const rec = await start("1000.00");
      await expect(
        reopenReconciliation({
          companyId: fixture.company.id,
          reconciliationId: rec.id,
          userId: owner.id,
        }),
      ).rejects.toThrow(/not finished/);
    });

    it("refuses one with a later statement resting on it", async () => {
      const into = await bankEntry("1000.00", 5);
      const first = await start("1000.00");
      await tick(first.id, bankLine(into));
      await completeReconciliation({
        companyId: fixture.company.id,
        reconciliationId: first.id,
        userId: owner.id,
      });

      const later = await bankEntry("400.00", 40);
      const second = await start("1400.00", new Date(Date.UTC(2026, 8, 30)));
      await tick(second.id, bankLine(later));
      await completeReconciliation({
        companyId: fixture.company.id,
        reconciliationId: second.id,
        userId: owner.id,
      });

      // September opened from August's balance, so August cannot be undone
      // without leaving September resting on a figure nobody agreed to.
      await expect(
        reopenReconciliation({
          companyId: fixture.company.id,
          reconciliationId: first.id,
          userId: owner.id,
        }),
      ).rejects.toThrow(/Reopen that first/);
    });

    it("frees the lines it cleared, so they can be reconciled again", async () => {
      const into = await bankEntry("1000.00", 5);
      const rec = await start("1000.00");
      await tick(rec.id, bankLine(into));
      await completeReconciliation({
        companyId: fixture.company.id,
        reconciliationId: rec.id,
        userId: owner.id,
      });

      await reopenReconciliation({
        companyId: fixture.company.id,
        reconciliationId: rec.id,
        userId: owner.id,
      });

      const state = await view(rec.id);
      expect(state.reconciliation.status).toBe("IN_PROGRESS");
      expect(state.lines).toHaveLength(1);
      expect(state.lines[0].cleared).toBe(true);
    });
  });

  describe("openingBalanceFor", () => {
    it("is zero before anything has been signed off", async () => {
      expect(
        (await openingBalanceFor(fixture.company.id, bankAccount.id, AUGUST_31)).toFixed(2),
      ).toBe("0.00");
    });
  });

  describe("scoping", () => {
    it("refuses a reconciliation from another company", async () => {
      await bankEntry("1000.00", 5);
      const rec = await start("1000.00");
      const elsewhere = await makeCompanyWithChart("Other Co", "PHP");

      await expect(
        reconciliationView({ companyId: elsewhere.company.id, reconciliationId: rec.id }),
      ).rejects.toThrow(/not found in this company/);
    });

    it("refuses to tick a line that is not on this account", async () => {
      await bankEntry("1000.00", 5);
      const rec = await start("1000.00");
      const elsewhere = await postJournalEntry({
        companyId: fixture.company.id,
        date: new Date(Date.UTC(2026, 7, 5)),
        sourceType: "MANUAL",
        userId: owner.id,
        role: "OWNER",
        // Neither line touches the bank account, which is the point.
        lines: [
          { accountId: fixture.code("6000").id, debit: "50.00" },
          { accountId: fixture.code("4000").id, credit: "50.00" },
        ],
      });

      await expect(tick(rec.id, elsewhere.lines[0].id)).rejects.toThrow(
        /not on this statement's account/,
      );
    });
  });
});
