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
import { PrismaClient, type Role, type Section } from "@prisma/client";
import { hashPassword } from "../src/lib/password";
import { createDefaultChartOfAccounts } from "../src/lib/ledger/chart";
import { postJournalEntry } from "../src/lib/ledger/post";
import { postOpeningBalances } from "../src/lib/ledger/opening-balances";
import { trialBalance } from "../src/lib/ledger/reports";
import { issueInvoice } from "../src/lib/invoices/service";
import { recordPayment } from "../src/lib/invoices/payments";
import { approveWorkOrder, computeWorkOrderLine } from "../src/lib/payables/work-orders";
import { recordBillPayment } from "../src/lib/payables/bill-payments";
import { recordExpense } from "../src/lib/payables/expenses";
import { parseLocalDateTime } from "../src/lib/time/zone";
import { computeSalesOrderLine, confirmSalesOrder } from "../src/lib/invoices/sales-orders";

const prisma = new PrismaClient();

const PASSWORD = "ledger-dev-password";

async function upsertUser(email: string, name: string, passwordHash: string) {
  return prisma.user.upsert({
    where: { email },
    create: { email, name, passwordHash },
    update: { name, passwordHash },
  });
}

async function member(
  userId: string,
  companyId: string,
  role: Role,
  sections: Section[] = [],
) {
  await prisma.membership.upsert({
    where: { userId_companyId: { userId, companyId } },
    create: { userId, companyId, role, sections },
    update: { role, sections },
  });
}

async function sequences(companyId: string) {
  const defaults = [
    { kind: "WORK_ORDER" as const, prefix: "WO", nextValue: 1001 },
    { kind: "INVOICE" as const, prefix: "INV", nextValue: 1001 },
    { kind: "JOURNAL_ENTRY" as const, prefix: "JE", nextValue: 1 },
    { kind: "SALES_ORDER" as const, prefix: "SO", nextValue: 1001 },
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
  // A full bookkeeper, plus two deliberately narrow ones so section access can
  // be seen working rather than taken on trust (SPEC §2.1).
  await member(bookkeeper.id, phpCompany.id, "BOOKKEEPER", [
    "SALES",
    "CONSULTANTS",
    "VENDORS",
    "BANKING",
    "REPORTS",
    "SETTINGS",
  ]);

  const salesUser = await upsertUser("sales@example.com", "Sofia Sales", passwordHash);
  await member(salesUser.id, phpCompany.id, "BOOKKEEPER", ["SALES"]);

  const apUser = await upsertUser("payables@example.com", "Paolo Payables", passwordHash);
  await member(apUser.id, phpCompany.id, "BOOKKEEPER", ["VENDORS"]);
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

  // ---- Phase 3: customers and invoices ------------------------------------
  const customerCount = await prisma.customer.count({ where: { companyId: phpCompany.id } });
  if (customerCount === 0) {
    const local = await prisma.customer.create({
      data: {
        companyId: phpCompany.id,
        name: "Cebu Retail Group",
        emails: ["ap@cebu-retail.test"],
        defaultCurrency: "PHP",
        paymentTermsDays: 30,
      },
    });
    const overseas = await prisma.customer.create({
      data: {
        companyId: phpCompany.id,
        name: "Northwind Systems (US)",
        emails: ["billing@northwind.test"],
        defaultCurrency: "USD",
        paymentTermsDays: 15,
      },
    });
    await prisma.customer.create({
      data: {
        companyId: phpCompany.id,
        name: "Davao Logistics",
        emails: ["accounts@davao-log.test"],
        defaultCurrency: "PHP",
        paymentTermsDays: 45,
      },
    });

    const draft = async (
      customerId: string,
      currency: string,
      fxRate: string,
      issue: Date,
      rate: string,
      quantity = "1",
    ) =>
      prisma.invoice.create({
        data: {
          companyId: phpCompany.id,
          customerId,
          issueDate: issue,
          dueDate: new Date(issue.getTime() + 30 * 86_400_000),
          currency,
          fxRate,
          lines: {
            create: [
              {
                lineNumber: 1,
                description: "Consulting services",
                quantity,
                rate,
                amount: (Number(quantity) * Number(rate)).toFixed(2),
                incomeAccountId: php("4000").id,
              },
            ],
          },
        },
      });

    // Paid in full, in base currency.
    const paidInvoice = await draft(local.id, "PHP", "1", new Date(Date.UTC(2026, 4, 5)), "85000.00");
    await issueInvoice({ companyId: phpCompany.id, invoiceId: paidInvoice.id, role: "OWNER" });
    await recordPayment({
      companyId: phpCompany.id,
      customerId: local.id,
      date: new Date(Date.UTC(2026, 4, 28)),
      amount: "85000.00",
      currency: "PHP",
      depositAccountId: php("1000").id,
      applications: [{ invoiceId: paidInvoice.id, amountApplied: "85000.00" }],
      role: "OWNER",
    });

    // The live FX path: a USD invoice in PHP books, part-paid at a different
    // rate, so realized FX and a pro-rata A/R relief both appear in the seed.
    const usdInvoice = await draft(overseas.id, "USD", "58.25", new Date(Date.UTC(2026, 5, 1)), "4000.00");
    await issueInvoice({ companyId: phpCompany.id, invoiceId: usdInvoice.id, role: "OWNER" });
    await recordPayment({
      companyId: phpCompany.id,
      customerId: overseas.id,
      date: new Date(Date.UTC(2026, 5, 20)),
      amount: "1500.00",
      currency: "USD",
      fxRate: "59.10",
      depositAccountId: php("1000").id,
      applications: [{ invoiceId: usdInvoice.id, amountApplied: "1500.00" }],
      role: "OWNER",
    });

    // Open and overdue, so the aging report has buckets to fill.
    const overdue = await draft(local.id, "PHP", "1", new Date(Date.UTC(2026, 2, 10)), "42000.00");
    await issueInvoice({ companyId: phpCompany.id, invoiceId: overdue.id, role: "OWNER" });

    // And one still in draft — no number, nothing posted.
    await draft(local.id, "PHP", "1", new Date(Date.UTC(2026, 6, 1)), "12000.00");
  }

  // ---- Phase 4: consultants, vendors, work orders, expenses ---------------
  const vendorCount = await prisma.vendor.count({ where: { companyId: phpCompany.id } });
  if (vendorCount === 0) {
    const abigail = await prisma.vendor.create({
      data: {
        companyId: phpCompany.id,
        kind: "CONSULTANT",
        name: "Abigail Bautista",
        email: "abigail@example.com",
        defaultCurrency: "PHP",
        defaultRate: "100000",
        defaultAccountId: php("5000").id,
        paymentTermsDays: 15,
        userId: consultantOne.id,
        externalRef: "C-001",
      },
    });
    const johnRex = await prisma.vendor.create({
      data: {
        companyId: phpCompany.id,
        kind: "CONSULTANT",
        name: "John Rex Meraveles",
        email: "johnrex@example.com",
        ccEmails: ["manager@example.test"],
        defaultCurrency: "PHP",
        defaultRate: "16000",
        defaultAccountId: php("5000").id,
        paymentTermsDays: 15,
        userId: consultantTwo.id,
        externalRef: "C-002",
      },
    });
    // A consultant who is paid but never emailed — the bulk send must exclude
    // them visibly rather than silently (SPEC §10.1).
    await prisma.vendor.create({
      data: {
        companyId: phpCompany.id,
        kind: "CONSULTANT",
        name: "Chareze Valencia",
        email: null,
        sendEmails: false,
        defaultCurrency: "PHP",
        defaultRate: "50000",
        defaultAccountId: php("5000").id,
        externalRef: "C-003",
      },
    });

    const meralco = await prisma.vendor.create({
      data: {
        companyId: phpCompany.id,
        kind: "REGULAR",
        name: "Meralco",
        email: "billing@meralco.test",
        defaultCurrency: "PHP",
        defaultAccountId: php("6250").id,
      },
    });
    await prisma.vendor.create({
      data: {
        companyId: phpCompany.id,
        kind: "REGULAR",
        name: "Globe Telecom",
        email: "ap@globe.test",
        defaultCurrency: "PHP",
        defaultAccountId: php("6400").id,
      },
    });

    const workOrder = async (
      vendorId: string,
      issue: Date,
      lines: { description: string; quantity: string; rate: string; code: string }[],
    ) =>
      prisma.workOrder.create({
        data: {
          companyId: phpCompany.id,
          vendorId,
          issueDate: issue,
          dueDate: new Date(issue.getTime() + 15 * 86_400_000),
          currency: "PHP",
          fxRate: "1",
          lines: {
            create: lines.map((line, index) => ({
              lineNumber: index + 1,
              description: line.description,
              quantity: line.quantity,
              rate: line.rate,
              amount: computeWorkOrderLine(line),
              accountId: php(line.code).id,
            })),
          },
        },
      });

    // Mirrors the user's real spreadsheet, including the deduction line.
    const paidWorkOrder = await workOrder(abigail.id, new Date(Date.UTC(2026, 7, 15)), [
      { description: "Consultation for period 072626-081026", quantity: "0.5", rate: "100000.00", code: "5000" },
    ]);
    await approveWorkOrder({ companyId: phpCompany.id, workOrderId: paidWorkOrder.id, role: "OWNER" });
    await recordBillPayment({
      companyId: phpCompany.id,
      vendorId: abigail.id,
      date: new Date(Date.UTC(2026, 7, 30)),
      amount: "50000.00",
      currency: "PHP",
      paymentAccountId: php("1000").id,
      applications: [{ workOrderId: paidWorkOrder.id, amountApplied: "50000.00" }],
      role: "OWNER",
    });

    // The advance has to exist before it can be recovered, or the balance sheet
    // shows a negative asset — DR Advances to Consultants / CR Bank when the
    // cash goes out, then the work order's deduction line clears it.
    await postJournalEntry({
      companyId: phpCompany.id,
      date: new Date(Date.UTC(2026, 6, 20)),
      memo: "Cash advance to John Rex Meraveles",
      sourceType: "MANUAL",
      role: "OWNER",
      lines: [
        { accountId: php("1200").id, debit: "3000.00", vendorId: johnRex.id },
        { accountId: php("1000").id, credit: "3000.00" },
      ],
    });

    const withAdvance = await workOrder(johnRex.id, new Date(Date.UTC(2026, 7, 15)), [
      { description: "Consultation for period 072626-081026", quantity: "0.5", rate: "16000.00", code: "5000" },
      { description: "Cash Advances", quantity: "1", rate: "-3000.00", code: "1200" },
    ]);
    await approveWorkOrder({ companyId: phpCompany.id, workOrderId: withAdvance.id, role: "OWNER" });

    // One still in draft, so the bulk screens have something unapproved.
    await workOrder(abigail.id, new Date(Date.UTC(2026, 8, 15)), [
      { description: "Consultation for period 081126-082526", quantity: "0.5", rate: "100000.00", code: "5000" },
    ]);

    await recordExpense({
      companyId: phpCompany.id,
      kind: "DIRECT",
      vendorId: meralco.id,
      date: new Date(Date.UTC(2026, 7, 10)),
      currency: "PHP",
      amount: "8750.00",
      expenseAccountId: php("6250").id,
      paymentAccountId: php("1000").id,
      description: "July electricity",
      role: "OWNER",
    });
    await recordExpense({
      companyId: phpCompany.id,
      kind: "BILL",
      vendorId: meralco.id,
      date: new Date(Date.UTC(2026, 8, 8)),
      dueDate: new Date(Date.UTC(2026, 8, 28)),
      currency: "PHP",
      amount: "9420.00",
      expenseAccountId: php("6250").id,
      description: "August electricity",
      role: "OWNER",
    });
  }

  // ---- Sales orders (SPEC §7.1a) ------------------------------------------
  const salesOrderCount = await prisma.salesOrder.count({ where: { companyId: phpCompany.id } });
  if (salesOrderCount === 0) {
    const customer = await prisma.customer.findFirst({
      where: { companyId: phpCompany.id, name: "Cebu Retail Group" },
    });
    if (customer) {
      const rate = "65000.00";
      const order = await prisma.salesOrder.create({
        data: {
          companyId: phpCompany.id,
          customerId: customer.id,
          orderDate: new Date(Date.UTC(2026, 7, 5)),
          expectedDate: new Date(Date.UTC(2026, 8, 15)),
          currency: "PHP",
          memo: "Agreed at the August review",
          total: computeSalesOrderLine({ quantity: "1", rate }),
          lines: {
            create: [
              {
                lineNumber: 1,
                description: "Q4 advisory retainer",
                quantity: "1",
                rate,
                amount: computeSalesOrderLine({ quantity: "1", rate }),
                incomeAccountId: php("4000").id,
              },
            ],
          },
        },
      });
      // Confirmed but not invoiced: agreed work that must not appear in the P&L.
      await confirmSalesOrder({ companyId: phpCompany.id, salesOrderId: order.id });
    }
  }

  // ---- A consultant bill that is not a work order (SPEC §8.2) -------------
  const consultantBills = await prisma.expense.count({
    where: { companyId: phpCompany.id, kind: "BILL", vendor: { kind: "CONSULTANT" } },
  });
  if (consultantBills === 0) {
    const abigail = await prisma.vendor.findFirst({
      where: { companyId: phpCompany.id, kind: "CONSULTANT", name: "Abigail Bautista" },
    });
    if (abigail) {
      await recordExpense({
        companyId: phpCompany.id,
        kind: "BILL",
        vendorId: abigail.id,
        date: new Date(Date.UTC(2026, 7, 18)),
        dueDate: new Date(Date.UTC(2026, 8, 2)),
        currency: "PHP",
        amount: "4500.00",
        expenseAccountId: php("6300").id,
        description: "Travel reimbursement — Cebu site visit",
        role: "OWNER",
      });
    }
  }

  // ---- Phase 6: a month of time entries -----------------------------------
  const timeEntryCount = await prisma.timeEntry.count({ where: { companyId: phpCompany.id } });
  if (timeEntryCount === 0) {
    const clockConsultants = await prisma.vendor.findMany({
      where: { companyId: phpCompany.id, kind: "CONSULTANT", userId: { not: null } },
      orderBy: { name: "asc" },
    });

    const zone = phpCompany.timeClockTimeZone;
    const shift = (dayKey: string, from: string, to: string) => ({
      clockInAt: parseLocalDateTime(`${dayKey}T${from}`, zone)!,
      clockOutAt: parseLocalDateTime(`${dayKey}T${to}`, zone)!,
    });

    // Four working weeks, weekdays only.
    const days: string[] = [];
    for (let day = 1; day <= 28; day++) {
      const dayKey = `2026-08-${String(day).padStart(2, "0")}`;
      const weekday = new Date(`${dayKey}T00:00:00Z`).getUTCDay();
      if (weekday !== 0 && weekday !== 6) days.push(dayKey);
    }

    for (const consultant of clockConsultants) {
      for (const dayKey of days) {
        const { clockInAt, clockOutAt } = shift(dayKey, "09:00", "17:30");
        await prisma.timeEntry.create({
          data: {
            companyId: phpCompany.id,
            consultantId: consultant.id,
            clockInAt,
            clockOutAt,
            durationMinutes: Math.round((clockOutAt.getTime() - clockInAt.getTime()) / 60000),
            note: "Client work",
            source: "SELF",
          },
        });
      }
    }

    // The case that breaks naive implementations: a shift starting 23:30 PHT
    // and ending 01:15 the next morning belongs entirely to the day it began.
    if (clockConsultants[0]) {
      const clockInAt = parseLocalDateTime("2026-08-19T23:30", zone)!;
      const clockOutAt = parseLocalDateTime("2026-08-20T01:15", zone)!;
      await prisma.timeEntry.create({
        data: {
          companyId: phpCompany.id,
          consultantId: clockConsultants[0].id,
          clockInAt,
          clockOutAt,
          durationMinutes: 105,
          note: "Overnight deployment window",
          source: "SELF",
        },
      });

      // And one still running, so the open-shift alert has something to show.
      await prisma.timeEntry.create({
        data: {
          companyId: phpCompany.id,
          consultantId: clockConsultants[0].id,
          clockInAt: parseLocalDateTime("2026-08-21T08:45", zone)!,
          source: "SELF",
        },
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
    bookkeeper@example.com       BOOKKEEPER of ${phpCompany.name}, all sections
    sales@example.com            BOOKKEEPER, SALES section only
    payables@example.com         BOOKKEEPER, VENDORS section only
    usd-bookkeeper@example.com   BOOKKEEPER of ${usdCompany.name}
    abigail@example.com          CONSULTANT (time clock only)
    johnrex@example.com          CONSULTANT (time clock only)

  ${phpCompany.name} has a chart of accounts, opening balances, 8 manual
  entries across the 2025 and 2026 fiscal years, three customers and four
  invoices — one paid, one USD invoice part-paid at a different rate (realized
  FX), one overdue and one still a draft. Three consultants (one never emailed)
  and two vendors, with work orders including a cash-advance deduction line, a
  direct expense and an unpaid bill. A month of time entries in ${phpCompany.timeClockTimeZone},
  including a shift crossing midnight and one still running. One confirmed
  sales order (posting nothing) and one consultant reimbursement bill.
  Trial balance ties at
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
