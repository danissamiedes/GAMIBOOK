import { PrismaClient, type Role, type Section } from "@prisma/client";
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
      "BillPaymentApplication", "BillPayment", "Expense",
      "WorkOrderLine", "WorkOrder", "Vendor",
      "PaymentApplication", "Payment", "InvoiceLine", "Invoice",
      "SalesOrderLine", "SalesOrder",
      "TaxRate", "Item", "Customer",
      "TimeEntry", "EmailBatchItem", "EmailBatch",
      "EmailLog", "EmailTemplate", "EmailConnection",
      "ImportRow", "ImportBatch",
      "InboxAttachment", "InboxMessage",
      "ReclassificationLine", "Reclassification",
      "JournalLine", "JournalEntry", "Account", "AuditLog",
      "PasswordResetToken", "Invitation", "NumberSequence",
      "Membership", "User",
      -- Subscription cascades from Organization, but ProviderWebhookEvent has
      -- no foreign key at all: it is keyed by the provider's own event id and
      -- deliberately stands alone. Left out of this list it survives a reset,
      -- and a test asserting on webhook events silently depends on file order.
      "Booking", "BookingGroup", "BookableUnit", "BookingRate", "BookingSettings",
      "Subscription", "ProviderWebhookEvent",
      "Company", "Organization"
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
      { companyId: company.id, kind: "SALES_ORDER", prefix: "SO", nextValue: 1001 },
      { companyId: company.id, kind: "PURCHASE_ORDER", prefix: "PO", nextValue: 1001 },
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

export async function makeUser(
  role: Role,
  companyId: string,
  email?: string,
  sections: Section[] = [],
) {
  const user = await prisma.user.create({
    data: {
      email: email ?? `${role.toLowerCase()}-${unique()}@example.test`,
      name: `${role} ${unique()}`,
      passwordHash: "not-a-real-hash",
    },
  });
  await prisma.membership.create({ data: { userId: user.id, companyId, role, sections } });
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

/** A vendor of either kind (SPEC §6). */
export async function makeVendor(
  companyId: string,
  kind: "CONSULTANT" | "REGULAR" = "CONSULTANT",
  options: { name?: string; currency?: string; rate?: string; email?: string } = {},
) {
  return prisma.vendor.create({
    data: {
      companyId,
      kind,
      name: options.name ?? `${kind === "CONSULTANT" ? "Consultant" : "Vendor"} ${unique()}`,
      email: options.email ?? "payee@example.test",
      defaultCurrency: options.currency ?? "PHP",
      defaultRate: kind === "CONSULTANT" ? (options.rate ?? "1000") : null,
    },
  });
}

/**
 * A work order as the old flow left it: approved **and posted** to accounts
 * payable, settled by paying the work order itself (SPEC §8.1b).
 *
 * Live books are full of these, and they keep working, so the tests that
 * cover them have to be able to make one. Nothing in the app posts this way
 * any more — approval commits, the bill posts — which is why this lives here
 * rather than in the library.
 */
export async function approveAsLegacyWorkOrder(
  companyId: string,
  workOrderId: string,
  options: { approvedAt?: Date | null; userId?: string | null; role?: Role | null } = {},
) {
  const { approveWorkOrder } = await import("@/lib/payables/work-orders");
  const { postJournalEntry } = await import("@/lib/ledger/post");
  const { systemAccount } = await import("@/lib/ledger/chart");
  const { SYSTEM_ACCOUNTS } = await import("@/lib/ledger/accounts");
  const { money, sum, toCents } = await import("@/lib/money");

  const { workOrder } = await approveWorkOrder({
    companyId,
    workOrderId,
    approvedAt: options.approvedAt,
    userId: options.userId,
    role: options.role,
  });
  const fresh = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { lines: { orderBy: { lineNumber: "asc" } } },
  });
  const rate = money(fresh.fxRate);
  const baseTotal = toCents(money(fresh.total).times(rate));
  const baseLines = fresh.lines.map((line) => ({
    line,
    baseAmount: toCents(money(line.amount).times(rate)),
  }));
  const residual = baseTotal.minus(sum(baseLines.map((entry) => entry.baseAmount)));

  const payable = await systemAccount(companyId, SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE, prisma);
  const lines = baseLines.map((entry) => ({
    accountId: entry.line.accountId,
    debit: entry.baseAmount.isNegative() ? undefined : entry.baseAmount,
    credit: entry.baseAmount.isNegative() ? entry.baseAmount.abs() : undefined,
    description: entry.line.description,
    vendorId: fresh.vendorId,
  }));
  lines.push({
    accountId: payable.id,
    credit: baseTotal,
    description: `Work order ${fresh.workOrderNumber}`,
    vendorId: fresh.vendorId,
  } as (typeof lines)[number]);
  if (!residual.isZero()) {
    const rounding = await systemAccount(companyId, SYSTEM_ACCOUNTS.FX_ROUNDING_DIFFERENCE, prisma);
    lines.push({
      accountId: rounding.id,
      debit: residual.isPositive() ? residual : undefined,
      credit: residual.isNegative() ? residual.abs() : undefined,
      description: "FX rounding difference",
    } as (typeof lines)[number]);
  }

  const entry = await postJournalEntry({
    companyId,
    date: fresh.approvedAt ?? fresh.issueDate,
    memo: `Work order ${fresh.workOrderNumber}`,
    sourceType: "WORK_ORDER",
    sourceId: fresh.id,
    userId: options.userId,
    role: options.role,
    lines,
  });

  await prisma.workOrder.update({
    where: { id: fresh.id },
    data: { postedOnApproval: true, baseTotal },
  });

  return { workOrder, entry };
}
