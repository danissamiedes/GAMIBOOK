import { afterAll, beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { issueInvoice } from "@/lib/invoices/service";
import { recordPayment } from "@/lib/invoices/payments";
import { commitStatement, stageStatement } from "@/lib/bank/import";
import { autoLinkCompany, runBankAutoLink, unambiguousMatches } from "@/lib/bank/auto-link";
import { accountBalance } from "@/lib/ledger/reports";
import { makeCompanyWithChart, makeCustomer, makeDraftInvoice, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const at = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day));

async function csv(rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Statement");
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.csv.writeBuffer());
}

/**
 * SPEC §8.4: linking the lines that can only mean one thing.
 *
 * The assertions that matter are the bank balance — auto-linking must post
 * nothing, ever — and the cases it refuses: two candidates, a date that is
 * merely close, and a company that has not switched it on.
 */
describe("bank auto-link", () => {
  let fixture: Fixture;
  let bankAccountId: string;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Auto Co", "PHP");
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

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const mapping = {
    dateColumn: "Date",
    descriptionColumn: "Description",
    amountLayout: "SIGNED" as const,
    amountColumn: "Amount",
    referenceColumn: "Reference",
    dateFormat: "ISO" as const,
  };

  const bankBalance = () =>
    accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.code("1000").id,
      asOf: at(2026, 12, 31),
    });

  /** A customer payment of `amount`, already recorded in the books. */
  const paidInvoice = async (amount: string, date: Date) => {
    const customer = await makeCustomer(fixture.company.id);
    const draft = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: at(2026, 6, 1),
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          rate: amount,
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    const { invoice } = await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: draft.id,
      role: "OWNER",
    });
    const { payment } = await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date,
      amount,
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: amount }],
      role: "OWNER",
    });
    return payment;
  };

  /** Import one statement line. */
  const statementLine = async (date: string, description: string, amount: string) => {
    const file = await csv([
      ["Date", "Description", "Amount", "Reference"],
      [date, description, amount, ""],
    ]);
    const staged = await stageStatement({ bankAccountId, bytes: file, fileName: "s.csv", mapping });
    await commitStatement({
      companyId: fixture.company.id,
      bankAccountId,
      fileName: "s.csv",
      rows: staged.valid,
    });
    return prisma.bankTransaction.findFirstOrThrow({
      where: { bankAccountId, status: "UNMATCHED" },
      orderBy: { createdAt: "desc" },
    });
  };

  it("links a line with exactly one payment behind it, and posts nothing", async () => {
    const payment = await paidInvoice("40000.00", at(2026, 6, 2));
    const before = await bankBalance();
    await statementLine("2026-06-02", "Transfer in", "40000.00");

    const result = await autoLinkCompany({ companyId: fixture.company.id });

    expect(result.linked).toHaveLength(1);
    // The whole reason this is safe to do unattended.
    expect((await bankBalance()).toFixed(2)).toBe(before.toFixed(2));

    const line = await prisma.bankTransaction.findFirstOrThrow({ where: { bankAccountId } });
    expect(line.status).toBe("MATCHED");
    expect(line.matchedPaymentId).toBe(payment.id);
    // Never true here: it linked a payment that already existed, so unmatching
    // must not reverse anything.
    expect(line.createdEntry).toBe(false);
  });

  it("refuses when two payments could be meant", async () => {
    // The same amount to the same party twice in a week is either a duplicate
    // or two real payments, and guessing gets it wrong half the time.
    await paidInvoice("40000.00", at(2026, 6, 2));
    await paidInvoice("40000.00", at(2026, 6, 2));
    await statementLine("2026-06-02", "Transfer in", "40000.00");

    expect(await unambiguousMatches({ companyId: fixture.company.id })).toHaveLength(0);
    const result = await autoLinkCompany({ companyId: fixture.company.id });
    expect(result.linked).toHaveLength(0);

    const line = await prisma.bankTransaction.findFirstOrThrow({ where: { bankAccountId } });
    expect(line.status).toBe("UNMATCHED");
  });

  it("refuses a payment that is merely close in date", async () => {
    // suggestCandidates allows five days so a person can weigh it up; that is
    // not enough on its own to act without one.
    await paidInvoice("40000.00", at(2026, 6, 2));
    await statementLine("2026-06-05", "Transfer in", "40000.00");

    expect(await unambiguousMatches({ companyId: fixture.company.id })).toHaveLength(0);
  });

  it("leaves a line with no payment behind it alone", async () => {
    await statementLine("2026-06-02", "Bank charge", "-250.00");

    const result = await autoLinkCompany({ companyId: fixture.company.id });
    expect(result.linked).toHaveLength(0);
    const line = await prisma.bankTransaction.findFirstOrThrow({ where: { bankAccountId } });
    expect(line.status).toBe("UNMATCHED");
  });

  it("does nothing for a company that has not switched it on", async () => {
    await paidInvoice("40000.00", at(2026, 6, 2));
    await statementLine("2026-06-02", "Transfer in", "40000.00");

    expect(await runBankAutoLink()).toHaveLength(0);
    const line = await prisma.bankTransaction.findFirstOrThrow({ where: { bankAccountId } });
    expect(line.status).toBe("UNMATCHED");

    await prisma.company.update({
      where: { id: fixture.company.id },
      data: { bankAutoLinkEnabled: true },
    });
    const runs = await runBankAutoLink();
    expect(runs[0].linked).toHaveLength(1);
  });

  it("records what it linked in the audit trail", async () => {
    await paidInvoice("40000.00", at(2026, 6, 2));
    await statementLine("2026-06-02", "Transfer in", "40000.00");
    await autoLinkCompany({ companyId: fixture.company.id });

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "bank.auto_linked" } });
    expect(audit.summary).toContain("1 bank line(s) linked");
  });

  it("does not reach into another company's bank lines", async () => {
    await paidInvoice("40000.00", at(2026, 6, 2));
    await statementLine("2026-06-02", "Transfer in", "40000.00");

    const elsewhere = await makeCompanyWithChart("Elsewhere", "PHP");
    const result = await autoLinkCompany({ companyId: elsewhere.company.id });
    expect(result.linked).toHaveLength(0);
    const line = await prisma.bankTransaction.findFirstOrThrow({ where: { bankAccountId } });
    expect(line.status).toBe("UNMATCHED");
  });
});
