/**
 * Seed (SPEC §13). Phase 1 skeleton: one organization, two companies — one
 * PHP-base (the production shape: consultants in PHP, clients in PHP or USD)
 * and one USD-base to exercise the mirror FX case — plus users, memberships
 * and the document sequences starting at WO1001.
 *
 * Later phases extend this file: chart of accounts (Phase 2), customers and
 * invoices (Phase 3), consultants and work orders (Phase 4), 18 months of
 * history spanning a fiscal-year boundary, and the import fixtures.
 */
import { PrismaClient, type Role } from "@prisma/client";
import { hashPassword } from "../src/lib/password";
import { createDefaultChartOfAccounts } from "../src/lib/ledger/chart";
import { postJournalEntry } from "../src/lib/ledger/post";
import { postOpeningBalances } from "../src/lib/ledger/opening-balances";
import { trialBalance } from "../src/lib/ledger/reports";

const prisma = new PrismaClient();

const PASSWORD = "ledger-dev-password";

async function upsertUser(email: string, name: string, passwordHash: string) {
  return prisma.user.upsert({
    where: { email },
    create: { email, name, passwordHash },
    update: { name, passwordHash },
  });
}

async function member(userId: string, companyId: string, role: Role) {
  await prisma.membership.upsert({
    where: { userId_companyId: { userId, companyId } },
    create: { userId, companyId, role },
    update: { role },
  });
}

async function sequences(companyId: string) {
  const defaults = [
    { kind: "WORK_ORDER" as const, prefix: "WO", nextValue: 1001 },
    { kind: "INVOICE" as const, prefix: "INV", nextValue: 1001 },
    { kind: "JOURNAL_ENTRY" as const, prefix: "JE", nextValue: 1 },
  ];
  for (const sequence of defaults) {
    await prisma.numberSequence.upsert({
      where: { companyId_kind: { companyId, kind: sequence.kind } },
      create: { companyId, ...sequence },
      update: {},
    });
  }
}

async function main() {
  const passwordHash = await hashPassword(PASSWORD);

  const organization = await prisma.organization.upsert({
    where: { id: "seed-org" },
    create: { id: "seed-org", name: "Bookkeeping Point" },
    update: { name: "Bookkeeping Point" },
  });

  const phpCompany = await prisma.company.upsert({
    where: { id: "seed-company-php" },
    create: {
      id: "seed-company-php",
      organizationId: organization.id,
      name: "Bookkeeping Point (PHP)",
      baseCurrency: "PHP",
      fiscalYearStartMonth: 1,
      timeClockTimeZone: "Asia/Manila",
      operatingTimeZone: "Asia/Manila",
      setupCompletedAt: new Date(),
    },
    update: {},
  });

  const usdCompany = await prisma.company.upsert({
    where: { id: "seed-company-usd" },
    create: {
      id: "seed-company-usd",
      organizationId: organization.id,
      name: "Northbridge Consulting (USD)",
      baseCurrency: "USD",
      fiscalYearStartMonth: 1,
      timeClockTimeZone: "Asia/Manila",
      operatingTimeZone: "America/New_York",
      setupCompletedAt: new Date(),
    },
    update: {},
  });

  await sequences(phpCompany.id);
  await sequences(usdCompany.id);

  const owner = await upsertUser("owner@example.com", "Olivia Owner", passwordHash);
  const bookkeeper = await upsertUser("bookkeeper@example.com", "Ben Bookkeeper", passwordHash);
  const consultantOne = await upsertUser("abigail@example.com", "Abigail Bautista", passwordHash);
  const consultantTwo = await upsertUser("johnrex@example.com", "John Rex Meraveles", passwordHash);

  await member(owner.id, phpCompany.id, "OWNER");
  await member(owner.id, usdCompany.id, "OWNER");
  await member(bookkeeper.id, phpCompany.id, "BOOKKEEPER");
  await member(consultantOne.id, phpCompany.id, "CONSULTANT");
  await member(consultantTwo.id, phpCompany.id, "CONSULTANT");

  // A bookkeeper in one company only — proves company scoping has teeth.
  const otherBookkeeper = await upsertUser("usd-bookkeeper@example.com", "Uma Ledger", passwordHash);
  await member(otherBookkeeper.id, usdCompany.id, "BOOKKEEPER");

  // ---- Phase 2: chart of accounts and a little history -------------------
  for (const company of [phpCompany, usdCompany]) {
    await createDefaultChartOfAccounts(company.id);
  }

  const accountsFor = async (companyId: string) => {
    const rows = await prisma.account.findMany({ where: { companyId } });
    const byCode = new Map(rows.map((row) => [row.code, row]));
    return (code: string) => {
      const account = byCode.get(code);
      if (!account) throw new Error(`Seed: no account ${code}`);
      return account;
    };
  };

  const php = await accountsFor(phpCompany.id);

  const alreadyPosted = await prisma.journalEntry.count({ where: { companyId: phpCompany.id } });
  if (alreadyPosted === 0) {
    // Opening balances, then a few manual entries spanning a fiscal-year
    // boundary so the retained-earnings roll-forward in Phase 5 has something
    // real to work with.
    await postOpeningBalances({
      companyId: phpCompany.id,
      date: new Date(Date.UTC(2025, 0, 1)),
      balances: [
        { accountId: php("1000").id, amount: "450000.00" },
        { accountId: php("1010").id, amount: "15000.00" },
        { accountId: php("2100").id, amount: "38000.00" },
      ],
      role: "OWNER",
    });

    const entries: { date: Date; memo: string; lines: { code: string; debit?: string; credit?: string }[] }[] = [
      {
        date: new Date(Date.UTC(2025, 2, 31)),
        memo: "Consulting income — Q1 2025",
        lines: [{ code: "1000", debit: "320000.00" }, { code: "4000", credit: "320000.00" }],
      },
      {
        date: new Date(Date.UTC(2025, 2, 31)),
        memo: "Consultant fees — Q1 2025",
        lines: [{ code: "5000", debit: "180000.00" }, { code: "1000", credit: "180000.00" }],
      },
      {
        date: new Date(Date.UTC(2025, 8, 30)),
        memo: "Consulting income — Q3 2025",
        lines: [{ code: "1000", debit: "410000.00" }, { code: "4000", credit: "410000.00" }],
      },
      {
        date: new Date(Date.UTC(2025, 8, 30)),
        memo: "Consultant fees — Q3 2025",
        lines: [{ code: "5000", debit: "245000.00" }, { code: "1000", credit: "245000.00" }],
      },
      {
        date: new Date(Date.UTC(2025, 11, 15)),
        memo: "Office rent — December 2025",
        lines: [{ code: "6200", debit: "35000.00" }, { code: "1000", credit: "35000.00" }],
      },
      // Second fiscal year, so prior-year profit has to roll into retained
      // earnings rather than sitting in current-year income.
      {
        date: new Date(Date.UTC(2026, 1, 28)),
        memo: "Consulting income — February 2026",
        lines: [{ code: "1000", debit: "260000.00" }, { code: "4000", credit: "260000.00" }],
      },
      {
        date: new Date(Date.UTC(2026, 1, 28)),
        memo: "Consultant fees — February 2026",
        lines: [{ code: "5000", debit: "150000.00" }, { code: "1000", credit: "150000.00" }],
      },
      {
        date: new Date(Date.UTC(2026, 6, 10)),
        memo: "Software subscriptions",
        lines: [{ code: "6050", debit: "8400.00" }, { code: "2100", credit: "8400.00" }],
      },
    ];

    for (const entry of entries) {
      await postJournalEntry({
        companyId: phpCompany.id,
        date: entry.date,
        memo: entry.memo,
        sourceType: "MANUAL",
        role: "OWNER",
        lines: entry.lines.map((line) => ({
          accountId: php(line.code).id,
          debit: line.debit,
          credit: line.credit,
        })),
      });
    }
  }

  const tb = await trialBalance({
    companyId: phpCompany.id,
    asOf: new Date(Date.UTC(2026, 11, 31)),
  });
  if (!tb.balanced) {
    throw new Error(
      `Seed produced an unbalanced ledger: debits ${tb.totalDebit} credits ${tb.totalCredit}`,
    );
  }

  console.log(`
Seed complete.

  Companies
    ${phpCompany.name}        base ${phpCompany.baseCurrency}
    ${usdCompany.name}   base ${usdCompany.baseCurrency}

  Sign in with any of these — password: ${PASSWORD}

    owner@example.com            OWNER of both companies
    bookkeeper@example.com       BOOKKEEPER of ${phpCompany.name}
    usd-bookkeeper@example.com   BOOKKEEPER of ${usdCompany.name}
    abigail@example.com          CONSULTANT (time clock only)
    johnrex@example.com          CONSULTANT (time clock only)

  ${phpCompany.name} has a chart of accounts, opening balances and 8 manual
  entries spanning the 2025 and 2026 fiscal years. Trial balance ties at
  ${tb.totalDebit.toFixed(2)} ${phpCompany.baseCurrency} on each side.
`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
