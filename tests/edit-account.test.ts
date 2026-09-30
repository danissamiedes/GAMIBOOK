import { beforeEach, describe, expect, it } from "vitest";
import { updateAccount, editableFields } from "@/lib/ledger/edit-account";
import { postJournalEntry } from "@/lib/ledger/post";
import { withCompanyScope } from "@/lib/company-scope";
import { makeCompanyWithChart, makeUser, prisma, resetDatabase } from "./helpers";

beforeEach(async () => {
  await resetDatabase();
});

async function setup() {
  const fixture = await makeCompanyWithChart("Chart Co");
  const user = await makeUser("OWNER", fixture.company.id);
  const scope = await withCompanyScope(user.id, fixture.company.id);
  return { fixture, scope };
}

/** An account of our own, with nothing posted to it. */
async function ownAccount(companyId: string, code = "6900") {
  return prisma.account.create({
    data: { companyId, code, name: "Teachers- Hoops", type: "EXPENSE", subtype: "EXPENSE" },
  });
}

describe("editing an account (SPEC §4.1)", () => {
  it("renames and renumbers without touching a single posting", async () => {
    const { fixture, scope } = await setup();
    const account = await ownAccount(fixture.company.id);

    await postJournalEntry({
      companyId: fixture.company.id,
      date: new Date(Date.UTC(2026, 2, 1)),
      memo: "Coaching",
      sourceType: "MANUAL",
      role: "OWNER",
      lines: [
        { accountId: account.id, debit: "300.00" },
        { accountId: fixture.code("1000").id, credit: "300.00" },
      ],
    });

    const before = await prisma.journalLine.findMany({ where: { accountId: account.id } });
    const result = await updateAccount(scope, account.id, {
      code: "5200",
      name: "Teachers — Hoops",
      type: "EXPENSE",
      subtype: "EXPENSE",
    });
    expect(result.ok).toBe(true);

    // Postings refer to the account by id, so the ledger is byte-identical.
    const after = await prisma.journalLine.findMany({ where: { accountId: account.id } });
    expect(after).toEqual(before);

    const stored = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.code).toBe("5200");
    expect(stored.name).toBe("Teachers — Hoops");
  });

  it("moves an expense into cost of sales, and says the reports have moved with it", async () => {
    // The reason this feature exists: fixing gross margin after the fact.
    const { fixture, scope } = await setup();
    const account = await ownAccount(fixture.company.id);
    await postJournalEntry({
      companyId: fixture.company.id,
      date: new Date(Date.UTC(2026, 2, 1)),
      memo: "Coaching",
      sourceType: "MANUAL",
      role: "OWNER",
      lines: [
        { accountId: account.id, debit: "300.00" },
        { accountId: fixture.code("1000").id, credit: "300.00" },
      ],
    });

    const result = await updateAccount(scope, account.id, {
      code: "5200",
      name: "Teachers- Hoops",
      type: "EXPENSE",
      subtype: "COST_OF_SALES",
    });

    expect(result).toMatchObject({ ok: true, restatesReports: true });
    const stored = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.subtype).toBe("COST_OF_SALES");
  });

  it("does not claim a restatement when the account has no postings", async () => {
    const { fixture, scope } = await setup();
    const account = await ownAccount(fixture.company.id);

    const result = await updateAccount(scope, account.id, {
      code: "5200",
      name: "Teachers- Hoops",
      type: "EXPENSE",
      subtype: "COST_OF_SALES",
    });
    expect(result).toMatchObject({ ok: true, restatesReports: false });
  });

  it("refuses to retype an account that has been posted to", async () => {
    // An expense reclassified as an asset silently rewrites every past P&L and
    // balance sheet. No warning text makes that safe to offer.
    const { fixture, scope } = await setup();
    const account = await ownAccount(fixture.company.id);
    await postJournalEntry({
      companyId: fixture.company.id,
      date: new Date(Date.UTC(2026, 2, 1)),
      memo: "Coaching",
      sourceType: "MANUAL",
      role: "OWNER",
      lines: [
        { accountId: account.id, debit: "300.00" },
        { accountId: fixture.code("1000").id, credit: "300.00" },
      ],
    });

    const result = await updateAccount(scope, account.id, {
      code: "6900",
      name: "Teachers- Hoops",
      type: "ASSET",
      subtype: "OTHER_CURRENT_ASSET",
    });

    expect(result).toEqual({ ok: false, problem: "typeLocked" });
    const stored = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.type).toBe("EXPENSE");
  });

  it("allows a retype before anything has been posted", async () => {
    const { fixture, scope } = await setup();
    const account = await ownAccount(fixture.company.id);

    const result = await updateAccount(scope, account.id, {
      code: "1600",
      name: "Studio Equipment",
      type: "ASSET",
      subtype: "FIXED_ASSET",
    });
    expect(result.ok).toBe(true);
    const stored = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.type).toBe("ASSET");
    expect(stored.subtype).toBe("FIXED_ASSET");
  });

  it("refuses a subtype that does not belong to the type", async () => {
    const { fixture, scope } = await setup();
    const account = await ownAccount(fixture.company.id);
    const result = await updateAccount(scope, account.id, {
      code: "6900",
      name: "Teachers- Hoops",
      type: "EXPENSE",
      subtype: "CASH",
    });
    expect(result).toEqual({ ok: false, problem: "subtype" });
  });

  it("refuses a code another account already uses", async () => {
    const { fixture, scope } = await setup();
    const account = await ownAccount(fixture.company.id);
    const result = await updateAccount(scope, account.id, {
      code: "1000", // the bank account from the default chart
      name: "Teachers- Hoops",
      type: "EXPENSE",
      subtype: "EXPENSE",
    });
    expect(result).toEqual({ ok: false, problem: "duplicate" });
  });

  it("lets an account keep its own code", async () => {
    // The uniqueness check must exclude the row being edited, or renaming
    // without renumbering would report a clash with itself.
    const { fixture, scope } = await setup();
    const account = await ownAccount(fixture.company.id);
    const result = await updateAccount(scope, account.id, {
      code: "6900",
      name: "Renamed",
      type: "EXPENSE",
      subtype: "EXPENSE",
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a system account outright", async () => {
    const { fixture, scope } = await setup();
    const receivable = fixture.system("ACCOUNTS_RECEIVABLE");

    const result = await updateAccount(scope, receivable.id, {
      code: "1105",
      name: "Trade Receivables",
      type: "ASSET",
      subtype: "ACCOUNTS_RECEIVABLE",
    });
    expect(result).toEqual({ ok: false, problem: "system" });

    const stored = await prisma.account.findUniqueOrThrow({ where: { id: receivable.id } });
    expect(stored.code).toBe(receivable.code);
    expect(stored.name).toBe(receivable.name);
  });

  it("needs a code and a name", async () => {
    const { fixture, scope } = await setup();
    const account = await ownAccount(fixture.company.id);
    const base = { type: "EXPENSE" as const, subtype: "EXPENSE" as const };
    expect(await updateAccount(scope, account.id, { ...base, code: "  ", name: "X" })).toEqual({
      ok: false,
      problem: "code",
    });
    expect(await updateAccount(scope, account.id, { ...base, code: "6900", name: " " })).toEqual({
      ok: false,
      problem: "name",
    });
  });

  it("cannot reach an account in another company", async () => {
    const { scope } = await setup();
    const other = await makeCompanyWithChart("Someone Else");
    const account = await ownAccount(other.company.id, "6901");

    const result = await updateAccount(scope, account.id, {
      code: "9999",
      name: "Hijacked",
      type: "EXPENSE",
      subtype: "EXPENSE",
    });
    expect(result).toEqual({ ok: false, problem: "notFound" });
  });
});

describe("what the edit screen may offer (SPEC §4.1)", () => {
  it("reports a system account as not editable", async () => {
    const { fixture, scope } = await setup();
    const fields = await editableFields(scope, fixture.system("ACCOUNTS_PAYABLE").id);
    expect(fields).toMatchObject({ editable: false });
  });

  it("locks the type once there are postings, and not before", async () => {
    const { fixture, scope } = await setup();
    const account = await ownAccount(fixture.company.id);
    expect(await editableFields(scope, account.id)).toMatchObject({
      editable: true,
      typeLocked: false,
      postings: 0,
    });

    await postJournalEntry({
      companyId: fixture.company.id,
      date: new Date(Date.UTC(2026, 2, 1)),
      memo: "Coaching",
      sourceType: "MANUAL",
      role: "OWNER",
      lines: [
        { accountId: account.id, debit: "300.00" },
        { accountId: fixture.code("1000").id, credit: "300.00" },
      ],
    });

    expect(await editableFields(scope, account.id)).toMatchObject({
      editable: true,
      typeLocked: true,
      postings: 1,
    });
  });
});
