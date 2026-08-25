import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { createDefaultChartOfAccounts } from "@/lib/ledger/chart";
import { isSupportedCurrency } from "@/lib/currency";
import { ALL_SECTIONS } from "@/lib/company-scope";
import { nextAvailableTheme } from "@/lib/company-theme";

/**
 * Creating a company (SPEC §3).
 *
 * A company is a whole set of books: its own chart of accounts, its own
 * customers and vendors, its own A/R and A/P, its own users. Nothing is shared
 * with a sibling company beyond the login — every model carries `companyId` and
 * every query filters by it, which is what makes two businesses on one
 * deployment safe rather than merely tidy.
 *
 * Four things have to be true before a new company is usable, and they happen
 * in one transaction because a company missing any of them is worse than no
 * company at all — a half-built one is reachable from the switcher and fails at
 * the first posting:
 *
 *   1. the Company row;
 *   2. its document sequences, or the first invoice cannot be numbered;
 *   3. its chart of accounts, or nothing can be posted at all;
 *   4. an OWNER membership for whoever created it, or nobody can reach it.
 */

/** The document numbering a company starts with. */
const DEFAULT_SEQUENCES = [
  { kind: "WORK_ORDER" as const, prefix: "WO", nextValue: 1001 },
  { kind: "INVOICE" as const, prefix: "INV", nextValue: 1001 },
  { kind: "JOURNAL_ENTRY" as const, prefix: "JE", nextValue: 1 },
  { kind: "SALES_ORDER" as const, prefix: "SO", nextValue: 1001 },
];

export type NewCompanyInput = {
  name: string;
  baseCurrency: string;
  fiscalYearStartMonth: number;
  timeClockTimeZone: string;
  operatingTimeZone: string;
  /** Who is creating it. They become its OWNER. */
  userId: string;
  /**
   * The organisation to file it under. Normally the one the creator is already
   * working in, so a person's companies stay together.
   */
  organizationId?: string | null;
};

/** Why these details cannot be used, or null. Shared by the form and the service. */
export function whyNotACompany(input: {
  name: string;
  baseCurrency: string;
  fiscalYearStartMonth: number;
}): string | null {
  if (!input.name.trim()) return "Give the company a name";
  if (input.name.trim().length > 120) return "That name is too long";
  if (!isSupportedCurrency(input.baseCurrency)) {
    return "Pick a base currency the app supports";
  }
  if (
    !Number.isInteger(input.fiscalYearStartMonth) ||
    input.fiscalYearStartMonth < 1 ||
    input.fiscalYearStartMonth > 12
  ) {
    return "The fiscal year has to start in a real month";
  }
  return null;
}

export async function createCompany(input: NewCompanyInput) {
  const name = input.name.trim();
  const baseCurrency = input.baseCurrency.toUpperCase();

  const refusal = whyNotACompany({ ...input, name, baseCurrency });
  if (refusal) throw new PostingError(refusal);

  return prisma.$transaction(async (tx) => {
    // Two companies with the same name under one login is a switcher nobody can
    // read. Not a database constraint, because two genuinely separate
    // organisations may well share a name.
    const clash = await tx.company.findFirst({
      where: {
        name,
        memberships: { some: { userId: input.userId } },
      },
      select: { id: true },
    });
    if (clash) throw new PostingError(`You already have a company called ${name}`);

    const organizationId = input.organizationId ?? (await organisationFor(input.userId, name, tx));

    // A distinct accent by default (SPEC §3): a second company that looks like
    // the first teaches nobody which one is open.
    const mine = await tx.membership.findMany({
      where: { userId: input.userId },
      select: { company: { select: { theme: true } } },
    });
    const theme = nextAvailableTheme(mine.map((m) => m.company.theme));

    const company = await tx.company.create({
      data: {
        organizationId,
        name,
        baseCurrency,
        fiscalYearStartMonth: input.fiscalYearStartMonth,
        timeClockTimeZone: input.timeClockTimeZone,
        operatingTimeZone: input.operatingTimeZone,
        theme,
        // Created through this form rather than the setup wizard, which exists
        // for the very first company on a fresh deployment.
        setupCompletedAt: new Date(),
      },
    });

    await tx.numberSequence.createMany({
      data: DEFAULT_SEQUENCES.map((sequence) => ({ companyId: company.id, ...sequence })),
    });

    await createDefaultChartOfAccounts(company.id, tx);

    await tx.membership.create({
      data: {
        userId: input.userId,
        companyId: company.id,
        role: "OWNER",
        // An OWNER holds every section anyway (see company-scope), but storing
        // them keeps the row readable on the Users screen.
        sections: ALL_SECTIONS,
      },
    });

    await writeAudit(
      {
        companyId: company.id,
        userId: input.userId,
        action: "company.created",
        entityType: "Company",
        entityId: company.id,
        summary: `Created ${name} — ${baseCurrency}, fiscal year from month ${input.fiscalYearStartMonth}, ${theme.toLowerCase()} accent`,
        data: {
          theme,
          baseCurrency,
          fiscalYearStartMonth: input.fiscalYearStartMonth,
          timeClockTimeZone: input.timeClockTimeZone,
          operatingTimeZone: input.operatingTimeZone,
        },
      },
      tx,
    );

    return company;
  });
}

/**
 * Where to file a new company: the organisation the creator already works in,
 * or a new one named after the company when they have none.
 */
async function organisationFor(userId: string, companyName: string, tx: Prisma.TransactionClient) {
  const existing = await tx.membership.findFirst({
    where: { userId },
    select: { company: { select: { organizationId: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing.company.organizationId;

  const organization = await tx.organization.create({ data: { name: companyName } });
  return organization.id;
}
