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
`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
