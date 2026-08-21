import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { postJournalEntry, reverseJournalEntry, allocateNumber } from "@/lib/ledger/post";
import { PostingError } from "@/lib/errors";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { makeCompanyWithChart, prisma, resetDatabase } from "./helpers";

/**
 * SPEC §4.2: the hard rules. Every one of these is also enforced by a database
 * constraint or trigger — see the last test in this file, which bypasses the
 * service entirely.
 */
describe("postJournalEntry", () => {
  let fixture: Awaited<ReturnType<typeof makeCompanyWithChart>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Ledger Co", "PHP");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const date = new Date("2026-03-15T00:00:00Z");

  it("posts a balanced entry and returns its lines", async () => {
    const entry = await postJournalEntry({
      companyId: fixture.company.id,
      date,
      memo: "Bank charge",
      sourceType: "MANUAL",
      lines: [
        { accountId: fixture.code("6000").id, debit: "250.00", description: "Monthly fee" },
        { accountId: fixture.code("1000").id, credit: "250.00" },
      ],
    });

    expect(entry.lines).toHaveLength(2);
    expect(entry.lines[0].debit.toFixed(2)).toBe("250.00");
    expect(entry.lines[1].credit.toFixed(2)).toBe("250.00");
    expect(entry.entryNumber).toBe(1);
    // Stored as a plain date: no time, no zone.
    expect(entry.date.toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });

  it("rejects an entry whose debits and credits differ", async () => {
    await expect(
      postJournalEntry({
        companyId: fixture.company.id,
        date,
        sourceType: "MANUAL",
        lines: [
          { accountId: fixture.code("6000").id, debit: "250.00" },
          { accountId: fixture.code("1000").id, credit: "249.99" },
        ],
      }),
    ).rejects.toThrow(/does not balance/);

    expect(await prisma.journalEntry.count()).toBe(0);
  });

  it("rejects an entry with fewer than two lines", async () => {
    await expect(
      postJournalEntry({
        companyId: fixture.company.id,
        date,
        sourceType: "MANUAL",
        lines: [{ accountId: fixture.code("6000").id, debit: "10.00" }],
      }),
    ).rejects.toThrow(/at least two lines/);
  });

  it("rejects a line carrying both a debit and a credit", async () => {
    await expect(
      postJournalEntry({
        companyId: fixture.company.id,
        date,
        sourceType: "MANUAL",
        lines: [
          { accountId: fixture.code("6000").id, debit: "10.00", credit: "5.00" },
          { accountId: fixture.code("1000").id, credit: "5.00" },
        ],
      }),
    ).rejects.toThrow(/either a debit or a credit/);
  });

  it("rejects negative and zero amounts", async () => {
    await expect(
      postJournalEntry({
        companyId: fixture.company.id,
        date,
        sourceType: "MANUAL",
        lines: [
          { accountId: fixture.code("6000").id, debit: "-10.00" },
          { accountId: fixture.code("1000").id, credit: "-10.00" },
        ],
      }),
    ).rejects.toThrow(/cannot be negative/);

    await expect(
      postJournalEntry({
        companyId: fixture.company.id,
        date,
        sourceType: "MANUAL",
        lines: [
          { accountId: fixture.code("6000").id, debit: "0" },
          { accountId: fixture.code("1000").id, credit: "0" },
        ],
      }),
    ).rejects.toThrow(/needs a debit or a credit/);
  });

  it("refuses an account belonging to another company", async () => {
    const other = await makeCompanyWithChart("Other Co", "USD");
    await expect(
      postJournalEntry({
        companyId: fixture.company.id,
        date,
        sourceType: "MANUAL",
        lines: [
          { accountId: other.code("6000").id, debit: "10.00" },
          { accountId: fixture.code("1000").id, credit: "10.00" },
        ],
      }),
    ).rejects.toThrow(/does not exist in this company/);
  });

  it("refuses an inactive account", async () => {
    await prisma.account.update({
      where: { id: fixture.code("6000").id },
      data: { isActive: false },
    });
    await expect(
      postJournalEntry({
        companyId: fixture.company.id,
        date,
        sourceType: "MANUAL",
        lines: [
          { accountId: fixture.code("6000").id, debit: "10.00" },
          { accountId: fixture.code("1000").id, credit: "10.00" },
        ],
      }),
    ).rejects.toThrow(/inactive/);
  });

  it("requires a party on control-account lines", async () => {
    const ar = fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE);
    await expect(
      postJournalEntry({
        companyId: fixture.company.id,
        date,
        sourceType: "INVOICE",
        lines: [
          { accountId: ar.id, debit: "100.00" },
          { accountId: fixture.code("4000").id, credit: "100.00" },
        ],
      }),
    ).rejects.toThrow(/must carry a customer/);

    const ap = fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE);
    await expect(
      postJournalEntry({
        companyId: fixture.company.id,
        date,
        sourceType: "WORK_ORDER",
        lines: [
          { accountId: fixture.code("5000").id, debit: "100.00" },
          { accountId: ap.id, credit: "100.00" },
        ],
      }),
    ).rejects.toThrow(/consultant or vendor/);

    // With the party present, the same entry posts.
    const ok = await postJournalEntry({
      companyId: fixture.company.id,
      date,
      sourceType: "WORK_ORDER",
      lines: [
        { accountId: fixture.code("5000").id, debit: "100.00" },
        { accountId: ap.id, credit: "100.00", consultantId: "consultant-1" },
      ],
    });
    expect(ok.lines[1].consultantId).toBe("consultant-1");
  });

  it("blocks posting into a closed period for anyone but an owner", async () => {
    await prisma.company.update({
      where: { id: fixture.company.id },
      data: { booksClosedThrough: new Date("2026-03-31T00:00:00Z") },
    });

    const lines = [
      { accountId: fixture.code("6000").id, debit: "10.00" },
      { accountId: fixture.code("1000").id, credit: "10.00" },
    ];

    await expect(
      postJournalEntry({ companyId: fixture.company.id, date, sourceType: "MANUAL", lines, role: "BOOKKEEPER" }),
    ).rejects.toThrow(/books are closed/);

    // The owner may, deliberately.
    const entry = await postJournalEntry({
      companyId: fixture.company.id,
      date,
      sourceType: "MANUAL",
      lines,
      role: "OWNER",
    });
    expect(entry.id).toBeTruthy();

    // And a date after the closed period is fine for everyone.
    const later = await postJournalEntry({
      companyId: fixture.company.id,
      date: new Date("2026-04-01T00:00:00Z"),
      sourceType: "MANUAL",
      lines,
      role: "BOOKKEEPER",
    });
    expect(later.id).toBeTruthy();
  });

  it("numbers entries gap-free, even when posted concurrently", async () => {
    const lines = [
      { accountId: fixture.code("6000").id, debit: "1.00" },
      { accountId: fixture.code("1000").id, credit: "1.00" },
    ];

    await Promise.all(
      Array.from({ length: 12 }, () =>
        postJournalEntry({ companyId: fixture.company.id, date, sourceType: "MANUAL", lines }),
      ),
    );

    const entries = await prisma.journalEntry.findMany({
      where: { companyId: fixture.company.id },
      orderBy: { entryNumber: "asc" },
      select: { entryNumber: true },
    });
    expect(entries.map((e) => e.entryNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("keeps each company's numbering separate", async () => {
    const other = await makeCompanyWithChart("Separate Co", "USD");
    const post = (f: typeof fixture) =>
      postJournalEntry({
        companyId: f.company.id,
        date,
        sourceType: "MANUAL",
        lines: [
          { accountId: f.code("6000").id, debit: "5.00" },
          { accountId: f.code("1000").id, credit: "5.00" },
        ],
      });

    await post(fixture);
    await post(fixture);
    const first = await post(other);
    expect(first.entryNumber).toBe(1);
  });

  it("formats work order numbers as WO1001 onwards", async () => {
    const allocations = await prisma.$transaction(async (tx) => [
      await allocateNumber(tx, fixture.company.id, "WORK_ORDER"),
      await allocateNumber(tx, fixture.company.id, "WORK_ORDER"),
    ]);
    expect(allocations.map((a) => a.formatted)).toEqual(["WO1001", "WO1002"]);
  });

  it("rolls back the whole operation when a posting fails mid-transaction", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.account.create({
          data: {
            companyId: fixture.company.id,
            code: "9999",
            name: "Temporary",
            type: "EXPENSE",
            subtype: "EXPENSE",
          },
        });
        await postJournalEntry(
          {
            companyId: fixture.company.id,
            date,
            sourceType: "MANUAL",
            lines: [
              { accountId: fixture.code("6000").id, debit: "10.00" },
              { accountId: fixture.code("1000").id, credit: "9.00" },
            ],
          },
          tx,
        );
      }),
    ).rejects.toThrow(PostingError);

    // The account created alongside the failed posting is gone too.
    expect(await prisma.account.count({ where: { code: "9999" } })).toBe(0);
  });
});

describe("reversal (SPEC §4.2 rule 3)", () => {
  let fixture: Awaited<ReturnType<typeof makeCompanyWithChart>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Reversal Co", "PHP");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("mirrors the lines, links the two entries and nets to nothing", async () => {
    const original = await postJournalEntry({
      companyId: fixture.company.id,
      date: new Date("2026-03-15T00:00:00Z"),
      memo: "Original",
      sourceType: "MANUAL",
      lines: [
        { accountId: fixture.code("6000").id, debit: "250.00" },
        { accountId: fixture.code("1000").id, credit: "250.00" },
      ],
    });

    const reversal = await reverseJournalEntry({
      companyId: fixture.company.id,
      entryId: original.id,
      date: new Date("2026-04-01T00:00:00Z"),
    });

    expect(reversal.lines[0].credit.toFixed(2)).toBe("250.00");
    expect(reversal.lines[1].debit.toFixed(2)).toBe("250.00");
    expect(reversal.date.toISOString().slice(0, 10)).toBe("2026-04-01");

    const linked = await prisma.journalEntry.findUniqueOrThrow({ where: { id: original.id } });
    expect(linked.reversedByEntryId).toBe(reversal.id);

    const totals = await prisma.journalLine.aggregate({
      where: { accountId: fixture.code("6000").id },
      _sum: { debit: true, credit: true },
    });
    expect(totals._sum.debit?.toFixed(2)).toBe(totals._sum.credit?.toFixed(2));
  });

  it("refuses to reverse the same entry twice", async () => {
    const original = await postJournalEntry({
      companyId: fixture.company.id,
      date: new Date("2026-03-15T00:00:00Z"),
      sourceType: "MANUAL",
      lines: [
        { accountId: fixture.code("6000").id, debit: "10.00" },
        { accountId: fixture.code("1000").id, credit: "10.00" },
      ],
    });
    await reverseJournalEntry({
      companyId: fixture.company.id,
      entryId: original.id,
      date: new Date("2026-03-16T00:00:00Z"),
    });
    await expect(
      reverseJournalEntry({
        companyId: fixture.company.id,
        entryId: original.id,
        date: new Date("2026-03-17T00:00:00Z"),
      }),
    ).rejects.toThrow(/already been reversed/);
  });

  it("will not reverse an entry belonging to another company", async () => {
    const other = await makeCompanyWithChart("Elsewhere", "USD");
    const entry = await postJournalEntry({
      companyId: other.company.id,
      date: new Date("2026-03-15T00:00:00Z"),
      sourceType: "MANUAL",
      lines: [
        { accountId: other.code("6000").id, debit: "10.00" },
        { accountId: other.code("1000").id, credit: "10.00" },
      ],
    });
    await expect(
      reverseJournalEntry({
        companyId: fixture.company.id,
        entryId: entry.id,
        date: new Date("2026-03-16T00:00:00Z"),
      }),
    ).rejects.toThrow(/not found in this company/);
  });
});
