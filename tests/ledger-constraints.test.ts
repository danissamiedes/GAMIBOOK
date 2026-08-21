import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { postJournalEntry } from "@/lib/ledger/post";
import { makeCompanyWithChart, prisma, resetDatabase } from "./helpers";

/**
 * The service layer is not the only thing standing between this business and a
 * broken ledger. These tests bypass it entirely and go straight at the tables,
 * the way a migration script or someone at a psql prompt would.
 */
describe("database-level ledger guarantees", () => {
  let fixture: Awaited<ReturnType<typeof makeCompanyWithChart>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Constraint Co", "PHP");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const post = () =>
    postJournalEntry({
      companyId: fixture.company.id,
      date: new Date("2026-03-15T00:00:00Z"),
      sourceType: "MANUAL",
      lines: [
        { accountId: fixture.code("6000").id, debit: "250.00" },
        { accountId: fixture.code("1000").id, credit: "250.00" },
      ],
    });

  it("refuses an unbalanced entry written directly to the tables", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const entry = await tx.journalEntry.create({
          data: {
            companyId: fixture.company.id,
            entryNumber: 900,
            date: new Date("2026-03-15T00:00:00Z"),
            sourceType: "MANUAL",
          },
        });
        await tx.journalLine.createMany({
          data: [
            { journalEntryId: entry.id, lineNumber: 1, accountId: fixture.code("6000").id, debit: "100.00" },
            { journalEntryId: entry.id, lineNumber: 2, accountId: fixture.code("1000").id, credit: "99.00" },
          ],
        });
      }),
    ).rejects.toThrow(/out of balance/);

    expect(await prisma.journalEntry.count()).toBe(0);
  });

  it("refuses a one-legged entry written directly", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const entry = await tx.journalEntry.create({
          data: {
            companyId: fixture.company.id,
            entryNumber: 901,
            date: new Date("2026-03-15T00:00:00Z"),
            sourceType: "MANUAL",
          },
        });
        await tx.journalLine.create({
          data: { journalEntryId: entry.id, lineNumber: 1, accountId: fixture.code("6000").id, debit: "100.00" },
        });
      }),
    ).rejects.toThrow(/at least 2 are required/);
  });

  it("refuses a line with both sides, and a negative amount", async () => {
    const makeLine = (debit: string, credit: string) =>
      prisma.$transaction(async (tx) => {
        const entry = await tx.journalEntry.create({
          data: {
            companyId: fixture.company.id,
            entryNumber: 902,
            date: new Date("2026-03-15T00:00:00Z"),
            sourceType: "MANUAL",
          },
        });
        await tx.journalLine.create({
          data: {
            journalEntryId: entry.id,
            lineNumber: 1,
            accountId: fixture.code("6000").id,
            debit,
            credit,
          },
        });
      });

    await expect(makeLine("10.00", "10.00")).rejects.toThrow(/journal_line_exactly_one_side/);
    await expect(makeLine("-10.00", "0")).rejects.toThrow(
      /journal_line_amounts_non_negative|journal_line_exactly_one_side/,
    );
  });

  it("refuses to edit or delete a posted entry", async () => {
    const entry = await post();

    await expect(
      prisma.journalEntry.update({ where: { id: entry.id }, data: { memo: "rewritten" } }),
    ).rejects.toThrow(/immutable/);

    await expect(
      prisma.journalEntry.update({
        where: { id: entry.id },
        data: { date: new Date("2026-01-01T00:00:00Z") },
      }),
    ).rejects.toThrow(/immutable/);

    await expect(prisma.journalEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
      /immutable/,
    );
  });

  it("refuses to edit or delete a posted line", async () => {
    const entry = await post();
    const line = entry.lines[0];

    await expect(
      prisma.journalLine.update({ where: { id: line.id }, data: { debit: "999.00" } }),
    ).rejects.toThrow(/immutable/);

    await expect(prisma.journalLine.delete({ where: { id: line.id } })).rejects.toThrow(
      /immutable/,
    );
  });

  it("still allows linking an entry to the reversal that undid it", async () => {
    const entry = await post();
    const reversal = await post();
    await expect(
      prisma.journalEntry.update({
        where: { id: entry.id },
        data: { reversedByEntryId: reversal.id },
      }),
    ).resolves.toBeTruthy();
  });

  it("keeps entry numbers unique within a company", async () => {
    await post();
    await expect(
      prisma.journalEntry.create({
        data: {
          companyId: fixture.company.id,
          entryNumber: 1,
          date: new Date("2026-03-15T00:00:00Z"),
          sourceType: "MANUAL",
        },
      }),
    ).rejects.toThrow();
  });

  it("keeps account codes unique within a company but not across companies", async () => {
    await expect(
      prisma.account.create({
        data: {
          companyId: fixture.company.id,
          code: "1000",
          name: "Duplicate bank",
          type: "ASSET",
          subtype: "CASH",
        },
      }),
    ).rejects.toThrow();

    const other = await makeCompanyWithChart("Other Chart Co", "USD");
    expect(other.code("1000").code).toBe("1000");
  });
});

describe("the guards themselves", () => {
  it("has every ledger trigger enabled", async () => {
    // A disabled trigger is silent: the books would keep accepting writes and
    // nothing would look wrong until a report did not balance. Assert it.
    const triggers = await prisma.$queryRaw<{ tgname: string; tgenabled: string }[]>`
      SELECT tgname, tgenabled::text FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname
    `;

    expect(triggers.map((t) => t.tgname)).toEqual([
      "journal_entry_immutable",
      "journal_entry_must_balance",
      "journal_line_immutable",
      "journal_line_must_balance",
    ]);
    for (const trigger of triggers) {
      expect(`${trigger.tgname}=${trigger.tgenabled}`).toBe(`${trigger.tgname}=O`);
    }
  });
});
