import { afterAll, beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { issueInvoice } from "@/lib/invoices/service";
import { recordPayment } from "@/lib/invoices/payments";
import { approveWorkOrder } from "@/lib/payables/work-orders";
import {
  commitStatement,
  dedupeHash,
  stageStatement,
  suggestMapping,
} from "@/lib/bank/import";
import {
  categoriseDirectly,
  linkToPayment,
  settleWithPayment,
  suggestCandidates,
  unmatch,
  unmatchedCount,
} from "@/lib/bank/match";
import { accountBalance } from "@/lib/ledger/reports";
import { trialBalance } from "@/lib/ledger/reports";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { money } from "@/lib/money";
import {
  makeCompanyWithChart,
  makeCustomer,
  makeDraftInvoice,
  makeVendor,
  prisma,
  resetDatabase,
} from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const at = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day));

/** A CSV in memory, so the tests exercise the real reader. */
async function csv(rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Statement");
  for (const row of rows) sheet.addRow(row);
  const buffer = await workbook.csv.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * SPEC §8.4 and acceptance §15.14.
 *
 * The spec is unusually direct about the failure mode: three outcomes that must
 * not overlap, and the one implementers skip — linking to a payment already in
 * the books — is what double-counts cash. So the assertions here are mostly
 * about the *bank account balance*, which is where double counting shows up.
 */
describe("bank import (SPEC §8.4)", () => {
  let fixture: Fixture;
  let bankAccountId: string;

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Bank Co", "PHP");
    const bank = await prisma.bankAccount.create({
      data: {
        companyId: fixture.company.id,
        name: "Operating account",
        accountId: fixture.code("1000").id,
        currency: "PHP",
        dateColumn: "Date",
        descriptionColumn: "Description",
        amountColumn: "Amount",
        amountLayout: "SIGNED",
        dateFormat: "ISO",
      },
    });
    bankAccountId = bank.id;
  });

  const bankBalance = () =>
    accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.code("1000").id,
      asOf: at(2026, 12, 31),
    });

  const mapping = {
    dateColumn: "Date",
    descriptionColumn: "Description",
    amountLayout: "SIGNED" as const,
    amountColumn: "Amount",
    referenceColumn: "Reference",
    dateFormat: "ISO" as const,
  };

  it("suggests a mapping from the headers, for both statement layouts", () => {
    expect(
      suggestMapping(["Date", "Description", "Amount", "Reference"]),
    ).toMatchObject({
      dateColumn: "Date",
      descriptionColumn: "Description",
      amountLayout: "SIGNED",
      amountColumn: "Amount",
    });
    expect(
      suggestMapping(["Posted", "Narrative", "Debit", "Credit"]),
    ).toMatchObject({
      dateColumn: "Posted",
      descriptionColumn: "Narrative",
      amountLayout: "DEBIT_CREDIT",
      debitColumn: "Debit",
      creditColumn: "Credit",
    });
  });

  it("reads a signed statement and dedupes on re-import", async () => {
    const file = await csv([
      ["Date", "Description", "Amount", "Reference"],
      ["2026-06-02", "Cebu Retail transfer", "40000.00", "TRF881"],
      ["2026-06-03", "Bank service fee", "-350.00", ""],
    ]);

    const staged = await stageStatement({
      bankAccountId,
      bytes: file,
      fileName: "june.csv",
      mapping,
    });
    expect(staged.valid).toHaveLength(2);
    expect(staged.duplicates).toHaveLength(0);
    expect(staged.valid[0].amount!.toFixed(2)).toBe("40000.00");
    expect(staged.valid[1].amount!.toFixed(2)).toBe("-350.00");

    await commitStatement({
      companyId: fixture.company.id,
      bankAccountId,
      fileName: "june.csv",
      rows: staged.valid,
    });
    expect(await unmatchedCount(fixture.company.id)).toBe(2);

    // The same statement again, plus one new line: only the new one is fresh.
    const overlapping = await csv([
      ["Date", "Description", "Amount", "Reference"],
      ["2026-06-02", "Cebu Retail transfer", "40000.00", "TRF881"],
      ["2026-06-03", "Bank service fee", "-350.00", ""],
      ["2026-06-09", "Interest", "12.50", ""],
    ]);
    const second = await stageStatement({
      bankAccountId,
      bytes: overlapping,
      fileName: "june-again.csv",
      mapping,
    });
    expect(second.duplicates).toHaveLength(2);
    expect(second.valid).toHaveLength(1);

    await commitStatement({
      companyId: fixture.company.id,
      bankAccountId,
      fileName: "june-again.csv",
      rows: second.valid,
    });
    expect(
      await prisma.bankTransaction.count({ where: { bankAccountId } }),
    ).toBe(3);
  });

  it("reads separate debit and credit columns, taking debit as money out", async () => {
    const file = await csv([
      ["Posted", "Narrative", "Debit", "Credit"],
      ["2026-06-02", "Customer transfer", "", "40000.00"],
      ["2026-06-04", "Supplier payment", "9500.00", ""],
    ]);
    const staged = await stageStatement({
      bankAccountId,
      bytes: file,
      fileName: "dc.csv",
      mapping: {
        dateColumn: "Posted",
        descriptionColumn: "Narrative",
        amountLayout: "DEBIT_CREDIT",
        debitColumn: "Debit",
        creditColumn: "Credit",
        dateFormat: "ISO",
      },
    });
    expect(staged.valid.map((row) => row.amount!.toFixed(2))).toEqual([
      "40000.00",
      "-9500.00",
    ]);
  });

  it("reports rows it cannot read instead of dropping them", async () => {
    const file = await csv([
      ["Date", "Description", "Amount", "Reference"],
      ["not a date", "Broken", "10.00", ""],
      ["2026-06-02", "", "10.00", ""],
      ["2026-06-03", "No amount", "abc", ""],
      ["2026-06-04", "Good", "10.00", ""],
    ]);
    const staged = await stageStatement({
      bankAccountId,
      bytes: file,
      fileName: "bad.csv",
      mapping,
    });
    expect(staged.valid).toHaveLength(1);
    expect(staged.rejected.map((row) => row.error)).toEqual([
      "Date could not be read — check the date format",
      "No description",
      "Amount is not a number",
    ]);
  });

  it("hashes on date, amount and description — not on row order or file", () => {
    const one = dedupeHash({
      date: at(2026, 6, 2),
      amount: money("40000.00"),
      description: "Cebu  Retail",
    });
    const two = dedupeHash({
      date: at(2026, 6, 2),
      amount: money("40000"),
      description: "cebu retail",
    });
    expect(one).toBe(two);
    const different = dedupeHash({
      date: at(2026, 6, 2),
      amount: money("40000.00"),
      description: "Someone else",
    });
    expect(different).not.toBe(one);
  });

  it("§15.14 — linking to a payment already recorded posts nothing, so cash is counted once", async () => {
    const customer = await makeCustomer(fixture.company.id, {
      name: "Cebu Retail",
    });
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: at(2026, 6, 1),
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          rate: "40000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
      role: "OWNER",
    });

    // The payment is entered in the app first — the bank line is its echo.
    const { payment } = await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: at(2026, 6, 2),
      amount: "40000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "40000.00" }],
      role: "OWNER",
    });
    const afterPayment = await bankBalance();
    expect(afterPayment.toFixed(2)).toBe("40000.00");

    const file = await csv([
      ["Date", "Description", "Amount", "Reference"],
      ["2026-06-02", "Cebu Retail transfer", "40000.00", "TRF881"],
    ]);
    const staged = await stageStatement({
      bankAccountId,
      bytes: file,
      fileName: "s.csv",
      mapping,
    });
    await commitStatement({
      companyId: fixture.company.id,
      bankAccountId,
      fileName: "s.csv",
      rows: staged.valid,
    });
    const line = await prisma.bankTransaction.findFirstOrThrow({
      where: { bankAccountId },
    });

    const candidates = await suggestCandidates({
      companyId: fixture.company.id,
      transactionId: line.id,
    });
    expect(candidates.map((candidate) => candidate.id)).toEqual([payment.id]);

    await linkToPayment({
      companyId: fixture.company.id,
      transactionId: line.id,
      paymentId: payment.id,
    });

    // The whole point: the balance did not move, because nothing was posted.
    expect((await bankBalance()).toFixed(2)).toBe("40000.00");
    const matched = await prisma.bankTransaction.findUniqueOrThrow({
      where: { id: line.id },
    });
    expect(matched.status).toBe("MATCHED");
    expect(matched.createdEntry).toBe(false);
    expect(matched.matchedJournalEntryId).not.toBeNull();
    expect(await unmatchedCount(fixture.company.id)).toBe(0);
  });

  it("§15.14 — creating a payment from a bank line posts once, and settles the invoice", async () => {
    const customer = await makeCustomer(fixture.company.id, {
      name: "Cebu Retail",
    });
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: at(2026, 6, 1),
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          rate: "40000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
      role: "OWNER",
    });
    expect((await bankBalance()).toFixed(2)).toBe("0.00");

    const file = await csv([
      ["Date", "Description", "Amount", "Reference"],
      ["2026-06-02", "Cebu Retail transfer", "40000.00", "TRF881"],
    ]);
    const staged = await stageStatement({
      bankAccountId,
      bytes: file,
      fileName: "s.csv",
      mapping,
    });
    await commitStatement({
      companyId: fixture.company.id,
      bankAccountId,
      fileName: "s.csv",
      rows: staged.valid,
    });
    const line = await prisma.bankTransaction.findFirstOrThrow({
      where: { bankAccountId },
    });

    await settleWithPayment({
      companyId: fixture.company.id,
      transactionId: line.id,
      customerId: customer.id,
      applications: [{ invoiceId: invoice.id, amountApplied: "40000.00" }],
      role: "OWNER",
    });

    // Exactly once, and the invoice is settled.
    expect((await bankBalance()).toFixed(2)).toBe("40000.00");
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
        .status,
    ).toBe("PAID");
    const matched = await prisma.bankTransaction.findUniqueOrThrow({
      where: { id: line.id },
    });
    expect(matched.status).toBe("MATCHED");
    // This match created the payment, so unmatching owns undoing it.
    expect(matched.createdEntry).toBe(true);
    expect(matched.matchedPaymentId).not.toBeNull();

    const balanced = await trialBalance({
      companyId: fixture.company.id,
      asOf: at(2026, 12, 31),
    });
    expect(balanced.totalDebit.toFixed(2)).toBe(
      balanced.totalCredit.toFixed(2),
    );
  });

  it("categorises a bank fee directly, posting one entry", async () => {
    const file = await csv([
      ["Date", "Description", "Amount", "Reference"],
      ["2026-06-03", "Bank service fee", "-350.00", ""],
    ]);
    const staged = await stageStatement({
      bankAccountId,
      bytes: file,
      fileName: "s.csv",
      mapping,
    });
    await commitStatement({
      companyId: fixture.company.id,
      bankAccountId,
      fileName: "s.csv",
      rows: staged.valid,
    });
    const line = await prisma.bankTransaction.findFirstOrThrow({
      where: { bankAccountId },
    });

    await categoriseDirectly({
      companyId: fixture.company.id,
      transactionId: line.id,
      accountId: fixture.code("6000").id,
      role: "OWNER",
    });

    expect((await bankBalance()).toFixed(2)).toBe("-350.00");
    const matched = await prisma.bankTransaction.findUniqueOrThrow({
      where: { id: line.id },
    });
    expect(matched.createdEntry).toBe(true);
    const balanced = await trialBalance({
      companyId: fixture.company.id,
      asOf: at(2026, 12, 31),
    });
    expect(balanced.totalDebit.toFixed(2)).toBe(
      balanced.totalCredit.toFixed(2),
    );
  });

  it("unmatching reverses what the match created — and nothing when it created nothing", async () => {
    const customer = await makeCustomer(fixture.company.id);
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: at(2026, 6, 1),
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          rate: "40000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
      role: "OWNER",
    });
    const { payment } = await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: at(2026, 6, 2),
      amount: "40000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "40000.00" }],
      role: "OWNER",
    });

    const file = await csv([
      ["Date", "Description", "Amount", "Reference"],
      ["2026-06-02", "Cebu transfer", "40000.00", ""],
      ["2026-06-03", "Bank service fee", "-350.00", ""],
    ]);
    const staged = await stageStatement({
      bankAccountId,
      bytes: file,
      fileName: "s.csv",
      mapping,
    });
    await commitStatement({
      companyId: fixture.company.id,
      bankAccountId,
      fileName: "s.csv",
      rows: staged.valid,
    });
    const [linked, fee] = await prisma.bankTransaction.findMany({
      where: { bankAccountId },
      orderBy: { date: "asc" },
    });

    await linkToPayment({
      companyId: fixture.company.id,
      transactionId: linked.id,
      paymentId: payment.id,
    });
    await categoriseDirectly({
      companyId: fixture.company.id,
      transactionId: fee.id,
      accountId: fixture.code("6000").id,
      role: "OWNER",
    });
    expect((await bankBalance()).toFixed(2)).toBe("39650.00");

    // Unmatching the linked line must not touch the ledger: the payment is
    // still real, it is only no longer tied to this statement line.
    await unmatch({
      companyId: fixture.company.id,
      transactionId: linked.id,
      date: at(2026, 6, 30),
      role: "OWNER",
    });
    expect((await bankBalance()).toFixed(2)).toBe("39650.00");
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))
        .reversedAt,
    ).toBeNull();

    // Unmatching the categorised line must reverse the entry it wrote.
    await unmatch({
      companyId: fixture.company.id,
      transactionId: fee.id,
      date: at(2026, 6, 30),
      role: "OWNER",
    });
    expect((await bankBalance()).toFixed(2)).toBe("40000.00");
    expect(await unmatchedCount(fixture.company.id)).toBe(2);
  });

  it("unmatching a line that created a payment reverses it and reopens the invoice", async () => {
    const customer = await makeCustomer(fixture.company.id);
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: at(2026, 6, 1),
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          rate: "40000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
      role: "OWNER",
    });

    const file = await csv([
      ["Date", "Description", "Amount", "Reference"],
      ["2026-06-02", "Cebu transfer", "40000.00", ""],
    ]);
    const staged = await stageStatement({
      bankAccountId,
      bytes: file,
      fileName: "s.csv",
      mapping,
    });
    await commitStatement({
      companyId: fixture.company.id,
      bankAccountId,
      fileName: "s.csv",
      rows: staged.valid,
    });
    const line = await prisma.bankTransaction.findFirstOrThrow({
      where: { bankAccountId },
    });

    await settleWithPayment({
      companyId: fixture.company.id,
      transactionId: line.id,
      customerId: customer.id,
      applications: [{ invoiceId: invoice.id, amountApplied: "40000.00" }],
      role: "OWNER",
    });
    expect((await bankBalance()).toFixed(2)).toBe("40000.00");

    await unmatch({
      companyId: fixture.company.id,
      transactionId: line.id,
      date: at(2026, 6, 30),
      role: "OWNER",
    });

    // The cash is back out and the invoice is owed again — otherwise
    // unmatching leaves behind a payment attached to nothing.
    expect((await bankBalance()).toFixed(2)).toBe("0.00");
    const reopened = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(reopened.status).toBe("ISSUED");
    expect(money(reopened.balanceDue).toFixed(2)).toBe("40000.00");
    expect(await unmatchedCount(fixture.company.id)).toBe(1);
  });

  it("refuses the overlaps that would double-count cash", async () => {
    const customer = await makeCustomer(fixture.company.id);
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: at(2026, 6, 1),
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          rate: "40000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
      role: "OWNER",
    });
    const { payment } = await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: at(2026, 6, 2),
      amount: "40000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "40000.00" }],
      role: "OWNER",
    });

    const file = await csv([
      ["Date", "Description", "Amount", "Reference"],
      ["2026-06-02", "Cebu transfer", "40000.00", ""],
      ["2026-06-02", "Cebu transfer duplicate in life", "40000.00", ""],
    ]);
    const staged = await stageStatement({
      bankAccountId,
      bytes: file,
      fileName: "s.csv",
      mapping,
    });
    await commitStatement({
      companyId: fixture.company.id,
      bankAccountId,
      fileName: "s.csv",
      rows: staged.valid,
    });
    const [first, second] = await prisma.bankTransaction.findMany({
      where: { bankAccountId },
    });

    await linkToPayment({
      companyId: fixture.company.id,
      transactionId: first.id,
      paymentId: payment.id,
    });

    // A second line cannot claim the same payment — that would say the money
    // arrived twice.
    await expect(
      linkToPayment({
        companyId: fixture.company.id,
        transactionId: second.id,
        paymentId: payment.id,
      }),
    ).rejects.toThrow(/already linked/i);

    // And a matched line cannot be matched again by another route.
    await expect(
      categoriseDirectly({
        companyId: fixture.company.id,
        transactionId: first.id,
        accountId: fixture.code("6000").id,
        role: "OWNER",
      }),
    ).rejects.toThrow(/already matched/i);

    expect((await bankBalance()).toFixed(2)).toBe("40000.00");
  });

  it("only offers candidates on the right side of the ledger", async () => {
    const consultant = await makeVendor(fixture.company.id, "CONSULTANT");
    const workOrder = await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: consultant.id,
        issueDate: at(2026, 6, 1),
        dueDate: at(2026, 6, 30),
        currency: "PHP",
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "Fieldwork",
              quantity: "1",
              rate: "9500.00",
              amount: "9500.00",
              accountId: fixture.code("6000").id,
            },
          ],
        },
      },
    });
    await approveWorkOrder({
      companyId: fixture.company.id,
      workOrderId: workOrder.id,
      role: "OWNER",
    });

    const file = await csv([
      ["Date", "Description", "Amount", "Reference"],
      ["2026-06-05", "Payment to consultant", "-9500.00", ""],
    ]);
    const staged = await stageStatement({
      bankAccountId,
      bytes: file,
      fileName: "s.csv",
      mapping,
    });
    await commitStatement({
      companyId: fixture.company.id,
      bankAccountId,
      fileName: "s.csv",
      rows: staged.valid,
    });
    const line = await prisma.bankTransaction.findFirstOrThrow({
      where: { bankAccountId },
    });

    // Money out: no customer payments should be offered, and there is no bill
    // payment yet, so nothing is suggested and the user settles the document.
    expect(
      await suggestCandidates({
        companyId: fixture.company.id,
        transactionId: line.id,
      }),
    ).toEqual([]);

    await settleWithPayment({
      companyId: fixture.company.id,
      transactionId: line.id,
      vendorId: consultant.id,
      applications: [{ workOrderId: workOrder.id, amountApplied: "9500.00" }],
      role: "OWNER",
    });
    expect((await bankBalance()).toFixed(2)).toBe("-9500.00");
    expect(
      (
        await prisma.workOrder.findUniqueOrThrow({
          where: { id: workOrder.id },
        })
      ).status,
    ).toBe("PAID");
  });
});
