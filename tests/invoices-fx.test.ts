import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { issueInvoice } from "@/lib/invoices/service";
import { recordPayment } from "@/lib/invoices/payments";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { accountBalance, trialBalance } from "@/lib/ledger/reports";
import { money } from "@/lib/money";
import {
  makeCompanyWithChart,
  makeCustomer,
  makeDraftInvoice,
  prisma,
  resetDatabase,
} from "./helpers";

/**
 * The FX path this business actually runs (DECISIONS, SPEC §5): books in PHP,
 * a client invoiced in USD. The receivable comes off at the invoice's historic
 * rate; the difference against the payment's rate is realized FX.
 */
describe("USD invoice in PHP books", () => {
  let fixture: Awaited<ReturnType<typeof makeCompanyWithChart>>;
  let customer: Awaited<ReturnType<typeof makeCustomer>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Manila Books", "PHP");
    customer = await makeCustomer(fixture.company.id, { name: "US Client", currency: "USD" });
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const usdInvoice = (rate: string, lines?: { quantity: string; rate: string }[]) =>
    makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "USD",
      fxRate: rate,
      lines: (lines ?? [{ quantity: "1", rate: "1000.00" }]).map((line, index) => ({
        description: `Service ${index + 1}`,
        quantity: line.quantity,
        rate: line.rate,
        incomeAccountId: fixture.code("4000").id,
      })),
    });

  const arBalance = () =>
    accountBalance({
      companyId: fixture.company.id,
      accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE).id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });

  it("converts the invoice at its own rate and records the foreign amount", async () => {
    const invoice = await usdInvoice("58.25");
    const { invoice: issued, entry } = await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
    });

    // USD 1,000 at 58.25 is PHP 58,250 in the ledger.
    expect(money(issued.baseTotal).toFixed(2)).toBe("58250.00");
    const ar = entry.lines.find(
      (line) => line.accountId === fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE).id,
    );
    expect(ar?.debit.toFixed(2)).toBe("58250.00");
    expect(ar?.currency).toBe("USD");
    expect(ar?.foreignAmount?.toFixed(2)).toBe("1000.00");
    expect(ar?.fxRate?.toFixed(2)).toBe("58.25");
  });

  it("books a gain when the peso weakens between invoice and payment", async () => {
    const invoice = await usdInvoice("58.25");
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });

    // Paid when a dollar fetches PHP 59.00 — the same USD 1,000 brings in more.
    const { entry } = await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: new Date(Date.UTC(2026, 3, 10)),
      amount: "1000.00",
      currency: "USD",
      fxRate: "59.00",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "1000.00" }],
    });

    const bank = entry.lines.find((line) => line.accountId === fixture.code("1000").id);
    const ar = entry.lines.find(
      (line) => line.accountId === fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE).id,
    );
    const fx = entry.lines.find(
      (line) => line.accountId === fixture.system(SYSTEM_ACCOUNTS.REALIZED_FX_GAIN_LOSS).id,
    );

    expect(bank?.debit.toFixed(2)).toBe("59000.00"); // at the payment's rate
    expect(ar?.credit.toFixed(2)).toBe("58250.00"); // at the invoice's rate
    expect(fx?.credit.toFixed(2)).toBe("750.00"); // the difference, a gain

    // And the control account lands exactly on zero for this document.
    expect((await arBalance()).toFixed(2)).toBe("0.00");
  });

  it("books a loss when the peso strengthens", async () => {
    const invoice = await usdInvoice("58.25");
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });

    const { entry } = await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: new Date(Date.UTC(2026, 3, 10)),
      amount: "1000.00",
      currency: "USD",
      fxRate: "57.00",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "1000.00" }],
    });

    const fx = entry.lines.find(
      (line) => line.accountId === fixture.system(SYSTEM_ACCOUNTS.REALIZED_FX_GAIN_LOSS).id,
    );
    expect(fx?.debit.toFixed(2)).toBe("1250.00");
    expect((await arBalance()).toFixed(2)).toBe("0.00");
  });

  it("relieves A/R pro rata at the document rate on a partial payment", async () => {
    const invoice = await usdInvoice("58.25"); // USD 1,000 → PHP 58,250
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });

    // 40% of the invoice, at a different rate.
    const { entry } = await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: new Date(Date.UTC(2026, 3, 10)),
      amount: "400.00",
      currency: "USD",
      fxRate: "59.00",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "400.00" }],
    });

    const ar = entry.lines.find(
      (line) => line.accountId === fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE).id,
    );
    // 58,250 × 400/1,000 = 23,300 at the INVOICE's rate, not the payment's.
    expect(ar?.credit.toFixed(2)).toBe("23300.00");
    expect((await arBalance()).toFixed(2)).toBe("34950.00");

    // The rest, at yet another rate, must clear the control account exactly.
    await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: new Date(Date.UTC(2026, 4, 10)),
      amount: "600.00",
      currency: "USD",
      fxRate: "57.40",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: invoice.id, amountApplied: "600.00" }],
    });

    expect((await arBalance()).toFixed(2)).toBe("0.00");
    const settled = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(settled.status).toBe("PAID");
    expect(money(settled.baseRelieved).toFixed(2)).toBe("58250.00");
  });

  it("clears to zero even when the pro-rata split does not divide evenly", async () => {
    // A rate and amounts chosen so thirds do not land on whole cents.
    const invoice = await usdInvoice("58.3333", [{ quantity: "1", rate: "1000.00" }]);
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });

    for (const part of ["333.33", "333.33", "333.34"]) {
      await recordPayment({
        companyId: fixture.company.id,
        customerId: customer.id,
        date: new Date(Date.UTC(2026, 3, 10)),
        amount: part,
        currency: "USD",
        fxRate: "58.3333",
        depositAccountId: fixture.code("1000").id,
        applications: [{ invoiceId: invoice.id, amountApplied: part }],
      });
    }

    // The final payment takes the residual, so this is exactly zero.
    expect((await arBalance()).toFixed(2)).toBe("0.00");
  });

  it("posts the line-rounding residual to FX Rounding Difference", async () => {
    // SPEC §4.3: a rate like 0.017234 across seven lines. Converting each line
    // and adding up misses the converted total, and the entry would be
    // rejected — the residual has to go somewhere explicit.
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "USD",
      fxRate: "0.017234",
      lines: Array.from({ length: 7 }, (_, index) => ({
        description: `Line ${index + 1}`,
        quantity: "1",
        rate: "333.33",
        incomeAccountId: fixture.code("4000").id,
      })),
    });

    const { entry } = await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });

    const rounding = entry.lines.find(
      (line) => line.accountId === fixture.system(SYSTEM_ACCOUNTS.FX_ROUNDING_DIFFERENCE).id,
    );
    expect(rounding).toBeDefined();

    const debits = entry.lines.reduce((total, line) => total.plus(line.debit), money(0));
    const credits = entry.lines.reduce((total, line) => total.plus(line.credit), money(0));
    expect(debits.toFixed(2)).toBe(credits.toFixed(2));

    // Income is untouched by the fix: 7 × 333.33 × 0.017234, each rounded.
    const incomeLines = entry.lines.filter((line) => line.accountId === fixture.code("4000").id);
    expect(incomeLines).toHaveLength(7);
    for (const line of incomeLines) expect(line.credit.toFixed(2)).toBe("5.74");

    const tb = await trialBalance({
      companyId: fixture.company.id,
      asOf: new Date(Date.UTC(2026, 11, 31)),
    });
    expect(tb.balanced).toBe(true);
  });

  it("refuses a payment in a different currency from the invoice", async () => {
    const invoice = await usdInvoice("58.25");
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });

    await expect(
      recordPayment({
        companyId: fixture.company.id,
        customerId: customer.id,
        date: new Date(Date.UTC(2026, 3, 10)),
        amount: "58250.00",
        currency: "PHP",
        depositAccountId: fixture.code("1000").id,
        applications: [{ invoiceId: invoice.id, amountApplied: "58250.00" }],
      }),
    ).rejects.toThrow(/but invoice .* is in USD/);
  });

  it("needs a rate for a foreign invoice", async () => {
    const invoice = await usdInvoice("0");
    await expect(
      issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id }),
    ).rejects.toThrow(/needs an exchange rate/);
  });
});
