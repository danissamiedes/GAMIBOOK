import { zipSync, strToU8 } from "fflate";
import { prisma } from "@/lib/db";
import { csvCell } from "@/lib/reports/csv";
import { money } from "@/lib/money";
import { formatAccountingDate } from "@/lib/dates";

/**
 * The full data export (SPEC §13): every row this company owns, as CSVs in one
 * zip. The requirement is stated as a feeling — "the user must never feel their
 * books are trapped in this app" — so the bar is not "some data comes out" but
 * "another accountant could rebuild these books from this file".
 *
 * That is why the journal is exported line by line with its account code and
 * both amounts: the ledger is the books, and every document table here is a
 * convenience over it. A reader who trusts nothing else in the archive can add
 * up journal-lines.csv.
 */

type Table = { name: string; header: string[]; rows: unknown[][] };

const date = (value: Date | null | undefined) =>
  value ? formatAccountingDate(value) : "";
/** Timestamps stay full ISO in UTC — they are events, not accounting dates (SPEC §13). */
const instant = (value: Date | null | undefined) =>
  value ? value.toISOString() : "";
const decimal = (value: { toFixed(dp: number): string } | null | undefined) =>
  value ? value.toFixed(2) : "";
/** Rates carry more places than money; truncating them would lose the audit trail. */
const rate = (value: { toString(): string } | null | undefined) =>
  value ? value.toString() : "";

function toCsv(table: Table): string {
  return [table.header, ...table.rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

async function collectTables(companyId: string): Promise<Table[]> {
  const [
    company,
    accounts,
    entries,
    customers,
    vendors,
    items,
    taxRates,
    invoices,
    payments,
    workOrders,
    expenses,
    billPayments,
    timeEntries,
    salesOrders,
    auditLog,
  ] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId } }),
    prisma.account.findMany({ where: { companyId }, orderBy: { code: "asc" } }),
    prisma.journalEntry.findMany({
      where: { companyId },
      include: {
        lines: { include: { account: true }, orderBy: { lineNumber: "asc" } },
      },
      orderBy: { entryNumber: "asc" },
    }),
    prisma.customer.findMany({
      where: { companyId },
      orderBy: { name: "asc" },
    }),
    prisma.vendor.findMany({ where: { companyId }, orderBy: { name: "asc" } }),
    prisma.item.findMany({ where: { companyId }, orderBy: { name: "asc" } }),
    prisma.taxRate.findMany({ where: { companyId }, orderBy: { name: "asc" } }),
    prisma.invoice.findMany({
      where: { companyId },
      include: { customer: true, lines: { orderBy: { lineNumber: "asc" } } },
      orderBy: { issueDate: "asc" },
    }),
    prisma.payment.findMany({
      where: { companyId },
      include: { customer: true, applications: { include: { invoice: true } } },
      orderBy: { date: "asc" },
    }),
    prisma.workOrder.findMany({
      where: { companyId },
      include: { vendor: true, lines: { orderBy: { lineNumber: "asc" } } },
      orderBy: { issueDate: "asc" },
    }),
    prisma.expense.findMany({
      where: { companyId },
      include: { vendor: true },
      orderBy: { date: "asc" },
    }),
    prisma.billPayment.findMany({
      where: { companyId },
      include: {
        vendor: true,
        applications: { include: { workOrder: true, expense: true } },
      },
      orderBy: { date: "asc" },
    }),
    prisma.timeEntry.findMany({
      where: { companyId },
      include: { consultant: true },
      orderBy: { clockInAt: "asc" },
    }),
    prisma.salesOrder.findMany({
      where: { companyId },
      include: {
        customer: true,
        invoice: { select: { invoiceNumber: true } },
        lines: { orderBy: { lineNumber: "asc" } },
      },
      orderBy: { orderDate: "asc" },
    }),
    prisma.auditLog.findMany({
      where: { companyId },
      include: { user: { select: { email: true } } },
      orderBy: { at: "asc" },
    }),
  ]);

  const accountCode = new Map(
    accounts.map((account) => [account.id, account.code]),
  );

  return [
    {
      name: "company.csv",
      header: [
        "name",
        "baseCurrency",
        "fiscalYearStartMonth",
        "timeClockTimeZone",
        "operatingTimeZone",
        "booksClosedThrough",
        "exportedAt",
      ],
      rows: [
        [
          company.name,
          company.baseCurrency,
          company.fiscalYearStartMonth,
          company.timeClockTimeZone,
          company.operatingTimeZone,
          date(company.booksClosedThrough),
          new Date().toISOString(),
        ],
      ],
    },
    {
      name: "accounts.csv",
      header: [
        "code",
        "name",
        "type",
        "subtype",
        "systemKey",
        "parentCode",
        "isActive",
      ],
      rows: accounts.map((account) => [
        account.code,
        account.name,
        account.type,
        account.subtype,
        account.systemKey ?? "",
        account.parentId ? (accountCode.get(account.parentId) ?? "") : "",
        account.isActive,
      ]),
    },
    {
      name: "journal-entries.csv",
      header: [
        "entryNumber",
        "date",
        "memo",
        "sourceType",
        "sourceId",
        "postedAt",
        "reversedBy",
      ],
      rows: entries.map((entry) => [
        entry.entryNumber,
        date(entry.date),
        entry.memo ?? "",
        entry.sourceType,
        entry.sourceId ?? "",
        instant(entry.postedAt),
        entry.reversedByEntryId ?? "",
      ]),
    },
    {
      name: "journal-lines.csv",
      header: [
        "entryNumber",
        "date",
        "lineNumber",
        "accountCode",
        "accountName",
        "description",
        "debit",
        "credit",
        "currency",
        "fxRate",
        "foreignAmount",
        "customerId",
        "vendorId",
      ],
      rows: entries.flatMap((entry) =>
        entry.lines.map((line) => [
          entry.entryNumber,
          date(entry.date),
          line.lineNumber,
          line.account.code,
          line.account.name,
          line.description ?? "",
          decimal(line.debit),
          decimal(line.credit),
          line.currency ?? "",
          rate(line.fxRate),
          decimal(line.foreignAmount),
          line.customerId ?? "",
          line.vendorId ?? "",
        ]),
      ),
    },
    {
      name: "customers.csv",
      header: [
        "name",
        "emails",
        "billingAddress",
        "defaultCurrency",
        "paymentTermsDays",
        "notes",
        "isActive",
      ],
      rows: customers.map((customer) => [
        customer.name,
        customer.emails.join("; "),
        customer.billingAddress ?? "",
        customer.defaultCurrency,
        customer.paymentTermsDays,
        customer.notes ?? "",
        customer.isActive,
      ]),
    },
    {
      name: "vendors.csv",
      header: [
        "name",
        "kind",
        "email",
        "ccEmails",
        "sendEmails",
        "defaultCurrency",
        "defaultRate",
        "defaultAccountCode",
        "paymentTermsDays",
        "externalRef",
        "importAliases",
        "notes",
        "isActive",
      ],
      rows: vendors.map((vendor) => [
        vendor.name,
        vendor.kind,
        vendor.email ?? "",
        vendor.ccEmails.join("; "),
        vendor.sendEmails,
        vendor.defaultCurrency,
        rate(vendor.defaultRate),
        vendor.defaultAccountId
          ? (accountCode.get(vendor.defaultAccountId) ?? "")
          : "",
        vendor.paymentTermsDays,
        vendor.externalRef ?? "",
        vendor.importAliases.join("; "),
        vendor.notes ?? "",
        vendor.isActive,
      ]),
    },
    {
      name: "items.csv",
      header: [
        "name",
        "description",
        "defaultRate",
        "incomeAccountCode",
        "expenseAccountCode",
        "isActive",
      ],
      rows: items.map((item) => [
        item.name,
        item.description ?? "",
        rate(item.defaultRate),
        item.incomeAccountId
          ? (accountCode.get(item.incomeAccountId) ?? "")
          : "",
        item.expenseAccountId
          ? (accountCode.get(item.expenseAccountId) ?? "")
          : "",
        item.isActive,
      ]),
    },
    {
      name: "tax-rates.csv",
      header: ["name", "percent", "liabilityAccountCode", "isActive"],
      rows: taxRates.map((taxRate) => [
        taxRate.name,
        rate(taxRate.percent),
        accountCode.get(taxRate.liabilityAccountId) ?? "",
        taxRate.isActive,
      ]),
    },
    {
      name: "invoices.csv",
      header: [
        "invoiceNumber",
        "customer",
        "issueDate",
        "dueDate",
        "currency",
        "fxRate",
        "status",
        "subtotal",
        "taxTotal",
        "total",
        "amountPaid",
        "balanceDue",
        "baseTotal",
        "memo",
      ],
      rows: invoices.map((invoice) => [
        invoice.invoiceNumber ?? "(draft)",
        invoice.customer.name,
        date(invoice.issueDate),
        date(invoice.dueDate),
        invoice.currency,
        rate(invoice.fxRate),
        invoice.status,
        decimal(invoice.subtotal),
        decimal(invoice.taxTotal),
        decimal(invoice.total),
        decimal(invoice.amountPaid),
        decimal(invoice.balanceDue),
        decimal(invoice.baseTotal),
        invoice.memo ?? "",
      ]),
    },
    {
      name: "invoice-lines.csv",
      header: [
        "invoiceNumber",
        "lineNumber",
        "description",
        "quantity",
        "rate",
        "amount",
        "incomeAccountCode",
      ],
      rows: invoices.flatMap((invoice) =>
        invoice.lines.map((line) => [
          invoice.invoiceNumber ?? "(draft)",
          line.lineNumber,
          line.description,
          rate(line.quantity),
          rate(line.rate),
          decimal(line.amount),
          accountCode.get(line.incomeAccountId) ?? "",
        ]),
      ),
    },
    {
      name: "customer-payments.csv",
      header: [
        "date",
        "customer",
        "method",
        "reference",
        "currency",
        "fxRate",
        "amount",
        "unapplied",
        "depositAccountCode",
        "reversedAt",
        "appliedTo",
      ],
      rows: payments.map((payment) => [
        date(payment.date),
        payment.customer.name,
        payment.method,
        payment.reference ?? "",
        payment.currency,
        rate(payment.fxRate),
        decimal(payment.amount),
        decimal(
          payment.applications.reduce(
            (left, application) => left.minus(application.amountApplied),
            money(payment.amount),
          ),
        ),
        accountCode.get(payment.depositAccountId) ?? "",
        instant(payment.reversedAt),
        payment.applications
          .map(
            (application) =>
              `${application.invoice.invoiceNumber ?? "(draft)"}: ${decimal(application.amountApplied)}`,
          )
          .join("; "),
      ]),
    },
    {
      name: "work-orders.csv",
      header: [
        "workOrderNumber",
        "consultant",
        "issueDate",
        "approvedAt",
        "dueDate",
        "currency",
        "fxRate",
        "status",
        "total",
        "amountPaid",
        "balanceDue",
        "baseTotal",
        "memo",
      ],
      rows: workOrders.map((workOrder) => [
        workOrder.workOrderNumber ?? "(draft)",
        workOrder.vendor.name,
        date(workOrder.issueDate),
        date(workOrder.approvedAt),
        date(workOrder.dueDate),
        workOrder.currency,
        rate(workOrder.fxRate),
        workOrder.status,
        decimal(workOrder.total),
        decimal(workOrder.amountPaid),
        decimal(workOrder.balanceDue),
        decimal(workOrder.baseTotal),
        workOrder.memo ?? "",
      ]),
    },
    {
      name: "work-order-lines.csv",
      header: [
        "workOrderNumber",
        "lineNumber",
        "description",
        "quantity",
        "rate",
        "amount",
        "accountCode",
      ],
      rows: workOrders.flatMap((workOrder) =>
        workOrder.lines.map((line) => [
          workOrder.workOrderNumber ?? "(draft)",
          line.lineNumber,
          line.description,
          rate(line.quantity),
          rate(line.rate),
          decimal(line.amount),
          accountCode.get(line.accountId) ?? "",
        ]),
      ),
    },
    {
      name: "expenses.csv",
      header: [
        "date",
        "vendor",
        "kind",
        "description",
        "reference",
        "currency",
        "fxRate",
        "amount",
        "status",
        "amountPaid",
        "balanceDue",
        "expenseAccountCode",
        "paymentAccountCode",
        "dueDate",
        "isBillable",
      ],
      rows: expenses.map((expense) => [
        date(expense.date),
        expense.vendor?.name ?? "",
        expense.kind,
        expense.description,
        expense.reference ?? "",
        expense.currency,
        rate(expense.fxRate),
        decimal(expense.amount),
        expense.status,
        decimal(expense.amountPaid),
        decimal(expense.balanceDue),
        accountCode.get(expense.expenseAccountId) ?? "",
        expense.paymentAccountId
          ? (accountCode.get(expense.paymentAccountId) ?? "")
          : "",
        date(expense.dueDate),
        expense.isBillable,
      ]),
    },
    {
      name: "bill-payments.csv",
      header: [
        "date",
        "vendor",
        "method",
        "reference",
        "currency",
        "fxRate",
        "amount",
        "payFromAccountCode",
        "reversedAt",
        "appliedTo",
      ],
      rows: billPayments.map((payment) => [
        date(payment.date),
        payment.vendor.name,
        payment.method,
        payment.reference ?? "",
        payment.currency,
        rate(payment.fxRate),
        decimal(payment.amount),
        accountCode.get(payment.paymentAccountId) ?? "",
        instant(payment.reversedAt),
        payment.applications
          .map((application) => {
            const label =
              application.workOrder?.workOrderNumber ??
              application.expense?.description ??
              "(document)";
            return `${label}: ${decimal(application.amountApplied)}`;
          })
          .join("; "),
      ]),
    },
    {
      name: "time-entries.csv",
      header: [
        "consultant",
        "clockInAtUtc",
        "clockOutAtUtc",
        "durationMinutes",
        "note",
        "source",
        "editReason",
        "correctionRequest",
      ],
      rows: timeEntries.map((entry) => [
        entry.consultant.name,
        instant(entry.clockInAt),
        instant(entry.clockOutAt),
        entry.durationMinutes ?? "",
        entry.note ?? "",
        entry.source,
        entry.editReason ?? "",
        entry.correctionRequest ?? "",
      ]),
    },
    {
      name: "sales-orders.csv",
      header: [
        "orderNumber",
        "customer",
        "orderDate",
        "expectedDate",
        "currency",
        "status",
        "total",
        "convertedToInvoice",
      ],
      rows: salesOrders.map((order) => [
        order.orderNumber ?? "(draft)",
        order.customer.name,
        date(order.orderDate),
        date(order.expectedDate),
        order.currency,
        order.status,
        decimal(order.total),
        order.invoice?.invoiceNumber ?? "",
      ]),
    },
    {
      name: "sales-order-lines.csv",
      header: [
        "orderNumber",
        "lineNumber",
        "description",
        "quantity",
        "rate",
        "amount",
      ],
      rows: salesOrders.flatMap((order) =>
        order.lines.map((line) => [
          order.orderNumber ?? "(draft)",
          line.lineNumber,
          line.description,
          rate(line.quantity),
          rate(line.rate),
          decimal(line.amount),
        ]),
      ),
    },
    {
      name: "audit-log.csv",
      header: ["at", "user", "action", "entityType", "entityId", "summary"],
      rows: auditLog.map((row) => [
        instant(row.at),
        row.user?.email ?? "",
        row.action,
        row.entityType ?? "",
        row.entityId ?? "",
        row.summary ?? "",
      ]),
    },
  ];
}

function readme(companyName: string, tables: Table[]): string {
  const widest = Math.max(...tables.map((table) => table.name.length));
  const listing = tables
    .map(
      (table) =>
        `  ${table.name.padEnd(widest)}  ${table.rows.length} ${
          table.rows.length === 1 ? "row" : "rows"
        }`,
    )
    .join("\n");

  return [
    `Full data export — ${companyName}`,
    `Generated ${new Date().toISOString()}`,
    "",
    "Files",
    "-----",
    listing,
    "",
    "How to read this",
    "----------------",
    "journal-lines.csv is the books. Every other file is a document view over",
    "those lines, so if two files ever disagree, the journal is right.",
    "",
    "Amounts in journal-lines.csv are in the company's base currency. A line",
    "originally entered in another currency also carries its currency, the rate",
    "used, and the foreign amount, so the conversion can be checked.",
    "",
    "Accounting dates (invoice dates, posting dates) are yyyy-mm-dd with no time",
    "zone. Event timestamps (clock in/out, audit entries) are full ISO 8601 in",
    "UTC — convert them to the company's time zone before reading them as local",
    "times.",
    "",
    "Documents still in draft have no number allocated yet and appear as",
    '"(draft)". Numbers are allocated on issue or approval and are gap-free.',
    "",
    "This export is a copy, not a backup of the database itself. For a restorable",
    "backup, use the pg_dump command in the project README.",
    "",
  ].join("\n");
}

export async function buildCompanyExport(companyId: string): Promise<{
  filename: string;
  bytes: Uint8Array;
  tables: { name: string; rows: number }[];
}> {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { name: true },
  });
  const tables = await collectTables(companyId);

  const files: Record<string, Uint8Array> = {
    "README.txt": strToU8(readme(company.name, tables)),
  };
  for (const table of tables) {
    // A BOM so Excel opens UTF-8 names (Bautista, Meraveles) correctly rather
    // than as mojibake — the single most likely first impression of this file.
    files[table.name] = strToU8(`﻿${toCsv(table)}`);
  }

  // Accents are folded to their base letter before the strip, or "Ábigail"
  // loses its first letter rather than its accent.
  const slug =
    company.name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "company";

  return {
    filename: `${slug}-export-${formatAccountingDate(new Date())}.zip`,
    bytes: zipSync(files, { level: 6 }),
    tables: tables.map((table) => ({
      name: table.name,
      rows: table.rows.length,
    })),
  };
}
