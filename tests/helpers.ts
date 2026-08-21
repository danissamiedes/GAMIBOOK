import { PrismaClient, type Role } from "@prisma/client";
import { createDefaultChartOfAccounts } from "@/lib/ledger/chart";

export const prisma = new PrismaClient();

let counter = 0;
const unique = () => `${Date.now().toString(36)}-${counter++}`;

export async function resetDatabase() {
  // TRUNCATE rather than DELETE: it does not fire row-level triggers, so a
  // fixture teardown never has to disable the ledger's immutability or balance
  // guards. Disabling them was the earlier approach, and a crash between the
  // disable and the re-enable left a guard switched off in the test database —
  // exactly the kind of hole these guards exist to close.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "PaymentApplication", "Payment", "InvoiceLine", "Invoice",
      "TaxRate", "Item", "Customer",
      "JournalLine", "JournalEntry", "Account", "AuditLog",
      "PasswordResetToken", "Invitation", "NumberSequence",
      "Membership", "User", "Company", "Organization"
    RESTART IDENTITY CASCADE
  `);
}

export async function makeCompany(name: string, baseCurrency = "PHP") {
  const organization = await prisma.organization.create({ data: { name: `${name} Group` } });
  const company = await prisma.company.create({
    data: {
      organizationId: organization.id,
      name,
      baseCurrency,
      setupCompletedAt: new Date(),
    },
  });
  await prisma.numberSequence.createMany({
    data: [
      { companyId: company.id, kind: "JOURNAL_ENTRY", prefix: "JE", nextValue: 1 },
      { companyId: company.id, kind: "INVOICE", prefix: "INV", nextValue: 1001 },
      { companyId: company.id, kind: "WORK_ORDER", prefix: "WO", nextValue: 1001 },
    ],
  });
  return company;
}

/** A company with the default chart of accounts, ready to post into. */
export async function makeCompanyWithChart(name: string, baseCurrency = "PHP") {
  const company = await makeCompany(name, baseCurrency);
  await createDefaultChartOfAccounts(company.id, prisma);
  const accounts = await prisma.account.findMany({ where: { companyId: company.id } });
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const byKey = new Map(accounts.filter((a) => a.systemKey).map((a) => [a.systemKey as string, a]));
  return {
    company,
    accounts,
    /** Look an account up by its code, e.g. "1000" for the bank. */
    code: (code: string) => {
      const account = byCode.get(code);
      if (!account) throw new Error(`No account with code ${code}`);
      return account;
    },
    /** Look a system account up by key, e.g. ACCOUNTS_RECEIVABLE. */
    system: (key: string) => {
      const account = byKey.get(key);
      if (!account) throw new Error(`No system account ${key}`);
      return account;
    },
  };
}

export async function makeUser(role: Role, companyId: string, email?: string) {
  const user = await prisma.user.create({
    data: {
      email: email ?? `${role.toLowerCase()}-${unique()}@example.test`,
      name: `${role} ${unique()}`,
      passwordHash: "not-a-real-hash",
    },
  });
  await prisma.membership.create({ data: { userId: user.id, companyId, role } });
  return user;
}

/** A customer, ready to invoice. */
export async function makeCustomer(
  companyId: string,
  options: { name?: string; currency?: string; termsDays?: number } = {},
) {
  return prisma.customer.create({
    data: {
      companyId,
      name: options.name ?? `Customer ${unique()}`,
      emails: ["billing@example.test"],
      defaultCurrency: options.currency ?? "PHP",
      paymentTermsDays: options.termsDays ?? 30,
    },
  });
}

/** A draft invoice with the given lines, ready to issue. */
export async function makeDraftInvoice(options: {
  companyId: string;
  customerId: string;
  currency: string;
  fxRate?: string;
  issueDate?: Date;
  lines: { description: string; quantity: string; rate: string; incomeAccountId: string; taxRateId?: string }[];
}) {
  const issueDate = options.issueDate ?? new Date(Date.UTC(2026, 2, 15));
  const invoice = await prisma.invoice.create({
    data: {
      companyId: options.companyId,
      customerId: options.customerId,
      issueDate,
      dueDate: new Date(issueDate.getTime() + 30 * 86_400_000),
      currency: options.currency,
      fxRate: options.fxRate ?? "1",
      lines: {
        create: options.lines.map((line, index) => ({
          lineNumber: index + 1,
          description: line.description,
          quantity: line.quantity,
          rate: line.rate,
          amount: (Number(line.quantity) * Number(line.rate)).toFixed(2),
          incomeAccountId: line.incomeAccountId,
          taxRateId: line.taxRateId ?? null,
        })),
      },
    },
    include: { lines: true },
  });
  return invoice;
}
