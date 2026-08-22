import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { amendPosting, liveEntryFor } from "@/lib/ledger/amend";
import { postJournalEntry, reverseJournalEntry } from "@/lib/ledger/post";
import { accountBalance, trialBalance } from "@/lib/ledger/reports";
import { prisma } from "@/lib/db";
import { makeCompanyWithChart, makeUser, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const AUGUST = new Date(Date.UTC(2026, 7, 15));

describe("amendPosting (SPEC §4.2 rule 3)", () => {
  let fixture: Fixture;
  let owner: Awaited<ReturnType<typeof makeUser>>;

  const balance = (code: string) =>
    accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.code(code).id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });

  async function postOriginal(amount: string, date = AUGUST) {
    return postJournalEntry({
      companyId: fixture.company.id,
      date,
      memo: "Original",
      sourceType: "EXPENSE",
      sourceId: "doc-1",
      userId: owner.id,
      role: "OWNER",
      lines: [
        { accountId: fixture.code("6100").id, debit: amount },
        { accountId: fixture.code("1000").id, credit: amount },
      ],
    });
  }

  function correctedLines(amount: string) {
    return [
      { accountId: fixture.code("6100").id, debit: amount },
      { accountId: fixture.code("1000").id, credit: amount },
    ];
  }

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Amend Co");
    owner = await makeUser("OWNER", fixture.company.id);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("leaves only the corrected amount standing", async () => {
    await postOriginal("500.00");
    expect((await balance("6100")).toFixed(2)).toBe("500.00");

    await prisma.$transaction((tx) =>
      amendPosting(
        {
          companyId: fixture.company.id,
          sourceType: "EXPENSE",
          sourceId: "doc-1",
          date: AUGUST,
          memo: "Corrected",
          lines: correctedLines("800.00"),
          userId: owner.id,
          role: "OWNER",
        },
        tx,
      ),
    );

    expect((await balance("6100")).toFixed(2)).toBe("800.00");
    expect((await balance("1000")).toFixed(2)).toBe("-800.00");
  });

  it("keeps the trial balance tying", async () => {
    await postOriginal("500.00");
    await prisma.$transaction((tx) =>
      amendPosting(
        {
          companyId: fixture.company.id,
          sourceType: "EXPENSE",
          sourceId: "doc-1",
          date: AUGUST,
          lines: correctedLines("800.00"),
          userId: owner.id,
          role: "OWNER",
        },
        tx,
      ),
    );

    const tb = await trialBalance({
      companyId: fixture.company.id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit.toFixed(2)).toBe(tb.totalCredit.toFixed(2));
  });

  it("dates the reversal to the original entry, not to the correction", async () => {
    const original = await postOriginal("500.00", AUGUST);
    const september = new Date(Date.UTC(2026, 8, 22));

    const { reversal, reposted } = await prisma.$transaction((tx) =>
      amendPosting(
        {
          companyId: fixture.company.id,
          sourceType: "EXPENSE",
          sourceId: "doc-1",
          date: september,
          lines: correctedLines("800.00"),
          userId: owner.id,
          role: "OWNER",
        },
        tx,
      ),
    );

    expect(reversal.date.toISOString().slice(0, 10)).toBe(
      original.date.toISOString().slice(0, 10),
    );
    expect(reposted.date.toISOString().slice(0, 10)).toBe("2026-09-22");

    // August nets to nothing: the original and its reversal both sit there.
    const august = await accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.code("6100").id,
      asOf: new Date(Date.UTC(2026, 7, 31)),
    });
    expect(august.toFixed(2)).toBe("0.00");
  });

  it("can be applied twice, correcting the correction", async () => {
    await postOriginal("500.00");
    for (const amount of ["800.00", "650.00"]) {
      await prisma.$transaction((tx) =>
        amendPosting(
          {
            companyId: fixture.company.id,
            sourceType: "EXPENSE",
            sourceId: "doc-1",
            date: AUGUST,
            lines: correctedLines(amount),
            userId: owner.id,
            role: "OWNER",
          },
          tx,
        ),
      );
    }
    expect((await balance("6100")).toFixed(2)).toBe("650.00");
  });

  it("refuses when the books are closed and the caller is not an owner", async () => {
    await postOriginal("500.00");
    await prisma.company.update({
      where: { id: fixture.company.id },
      data: { booksClosedThrough: new Date(Date.UTC(2026, 7, 31)) },
    });

    await expect(
      prisma.$transaction((tx) =>
        amendPosting(
          {
            companyId: fixture.company.id,
            sourceType: "EXPENSE",
            sourceId: "doc-1",
            date: AUGUST,
            lines: correctedLines("800.00"),
            userId: owner.id,
            role: "BOOKKEEPER",
          },
          tx,
        ),
      ),
    ).rejects.toThrow(/books are closed/);

    expect((await balance("6100")).toFixed(2)).toBe("500.00");
  });

  it("refuses a document with nothing standing against it", async () => {
    const original = await postOriginal("500.00");
    await reverseJournalEntry({
      companyId: fixture.company.id,
      entryId: original.id,
      date: AUGUST,
      userId: owner.id,
      role: "OWNER",
    });

    await expect(
      prisma.$transaction((tx) =>
        liveEntryFor(fixture.company.id, "EXPENSE", "doc-1", tx),
      ),
    ).rejects.toThrow(/no posting standing/);
  });

  it("finds the repost, not the original, once corrected", async () => {
    await postOriginal("500.00");
    const { reposted } = await prisma.$transaction((tx) =>
      amendPosting(
        {
          companyId: fixture.company.id,
          sourceType: "EXPENSE",
          sourceId: "doc-1",
          date: AUGUST,
          lines: correctedLines("800.00"),
          userId: owner.id,
          role: "OWNER",
        },
        tx,
      ),
    );

    const live = await prisma.$transaction((tx) =>
      liveEntryFor(fixture.company.id, "EXPENSE", "doc-1", tx),
    );
    expect(live.id).toBe(reposted.id);
  });
});
