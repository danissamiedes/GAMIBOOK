import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  approveWorkOrder,
  computeWorkOrderLine,
  updateWorkOrder,
} from "@/lib/payables/work-orders";
import { recordExpense, updateExpense } from "@/lib/payables/expenses";
import {
  recordBillPayment,
  reverseBillPayment,
  updateBillPayment,
} from "@/lib/payables/bill-payments";
import { issueInvoice, updateInvoice } from "@/lib/invoices/service";
import { recordPayment, updatePayment } from "@/lib/invoices/payments";
import { confirmSalesOrder, updateSalesOrder } from "@/lib/invoices/sales-orders";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { accountBalance, trialBalance } from "@/lib/ledger/reports";
import { money } from "@/lib/money";
import {
  makeCompanyWithChart,
  makeCustomer,
  makeDraftInvoice,
  makeUser,
  makeVendor,
  prisma,
  resetDatabase,
} from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const AUG = new Date(Date.UTC(2026, 7, 15));
const AS_OF = new Date(Date.UTC(2026, 11, 31));

/**
 * Editing across every document type (SPEC §4.2 rule 3). The assertion that
 * matters everywhere is the same one: after a correction the ledger says the
 * new number, once, and the trial balance still ties.
 */
describe("editing transactions", () => {
  let fixture: Fixture;
  let owner: Awaited<ReturnType<typeof makeUser>>;

  const balance = (code: string) =>
    accountBalance({ companyId: fixture.company.id, accountId: fixture.code(code).id, asOf: AS_OF });
  const systemBalance = (key: string) =>
    accountBalance({ companyId: fixture.company.id, accountId: fixture.system(key).id, asOf: AS_OF });

  async function expectTies() {
    const tb = await trialBalance({ companyId: fixture.company.id, asOf: AS_OF });
    expect(tb.balanced).toBe(true);
  }

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Edit Co");
    owner = await makeUser("OWNER", fixture.company.id);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("direct expenses", () => {
    it("reprices and moves the account, leaving only the new figures", async () => {
      const { expense } = await recordExpense({
        companyId: fixture.company.id,
        kind: "DIRECT",
        date: AUG,
        currency: "PHP",
        amount: "1200.00",
        expenseAccountId: fixture.code("6100").id,
        paymentAccountId: fixture.code("1000").id,
        description: "Office chairs",
        userId: owner.id,
        role: "OWNER",
      });
      expect((await balance("6100")).toFixed(2)).toBe("1200.00");

      await updateExpense({
        companyId: fixture.company.id,
        expenseId: expense.id,
        date: AUG,
        currency: "PHP",
        amount: "1500.00",
        expenseAccountId: fixture.code("6300").id,
        paymentAccountId: fixture.code("1000").id,
        description: "Travel, not chairs",
        userId: owner.id,
        role: "OWNER",
      });

      expect((await balance("6100")).toFixed(2)).toBe("0.00");
      expect((await balance("6300")).toFixed(2)).toBe("1500.00");
      expect((await balance("1000")).toFixed(2)).toBe("-1500.00");
      const fresh = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
      expect(fresh.description).toBe("Travel, not chairs");
      expect(money(fresh.amount).toFixed(2)).toBe("1500.00");
      await expectTies();
    });
  });

  describe("bills", () => {
    it("edits an unpaid bill", async () => {
      const vendor = await makeVendor(fixture.company.id, "REGULAR");
      const { expense } = await recordExpense({
        companyId: fixture.company.id,
        kind: "BILL",
        vendorId: vendor.id,
        date: AUG,
        currency: "PHP",
        amount: "5000.00",
        expenseAccountId: fixture.code("6200").id,
        description: "August rent",
        userId: owner.id,
        role: "OWNER",
      });

      await updateExpense({
        companyId: fixture.company.id,
        expenseId: expense.id,
        vendorId: vendor.id,
        date: AUG,
        currency: "PHP",
        amount: "5500.00",
        expenseAccountId: fixture.code("6200").id,
        description: "August rent, revised",
        userId: owner.id,
        role: "OWNER",
      });

      const fresh = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
      expect(money(fresh.balanceDue).toFixed(2)).toBe("5500.00");
      expect(fresh.status).toBe("APPROVED");
      expect((await systemBalance(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE)).toFixed(2)).toBe("5500.00");
      await expectTies();
    });

    it("refuses a bill that has been paid", async () => {
      const vendor = await makeVendor(fixture.company.id, "REGULAR");
      const { expense } = await recordExpense({
        companyId: fixture.company.id,
        kind: "BILL",
        vendorId: vendor.id,
        date: AUG,
        currency: "PHP",
        amount: "5000.00",
        expenseAccountId: fixture.code("6200").id,
        description: "Rent",
        userId: owner.id,
        role: "OWNER",
      });
      await recordBillPayment({
        companyId: fixture.company.id,
        vendorId: vendor.id,
        date: AUG,
        amount: "5000.00",
        currency: "PHP",
        paymentAccountId: fixture.code("1000").id,
        applications: [{ expenseId: expense.id, amountApplied: "5000.00" }],
        userId: owner.id,
        role: "OWNER",
      });

      await expect(
        updateExpense({
          companyId: fixture.company.id,
          expenseId: expense.id,
          vendorId: vendor.id,
          date: AUG,
          currency: "PHP",
          amount: "9999.00",
          expenseAccountId: fixture.code("6200").id,
          description: "Sneaky",
          userId: owner.id,
          role: "OWNER",
        }),
      ).rejects.toThrow(/payments applied/);
    });
  });

  describe("work orders", () => {
    async function draft(rate: string) {
      return prisma.workOrder.create({
        data: {
          companyId: fixture.company.id,
          vendorId: (await makeVendor(fixture.company.id, "CONSULTANT")).id,
          issueDate: AUG,
          dueDate: new Date(Date.UTC(2026, 7, 30)),
          currency: "PHP",
          fxRate: "1",
          lines: {
            create: [
              {
                lineNumber: 1,
                description: "Work",
                quantity: "1",
                rate,
                amount: computeWorkOrderLine({ quantity: "1", rate }),
                accountId: fixture.code("5000").id,
              },
            ],
          },
        },
      });
    }

    it("edits a draft without posting anything", async () => {
      const workOrder = await draft("9000.00");

      await updateWorkOrder({
        companyId: fixture.company.id,
        workOrderId: workOrder.id,
        lines: [
          { description: "Work", quantity: "2", rate: "3000.00", accountId: fixture.code("5000").id },
          { description: "Extra", quantity: "1", rate: "500.00", accountId: fixture.code("5100").id },
        ],
        userId: owner.id,
        role: "OWNER",
      });

      const fresh = await prisma.workOrder.findUniqueOrThrow({
        where: { id: workOrder.id },
        include: { lines: { orderBy: { lineNumber: "asc" } } },
      });
      expect(fresh.status).toBe("DRAFT");
      expect(fresh.lines).toHaveLength(2);
      expect(money(fresh.total).toFixed(2)).toBe("6500.00");
      expect(await prisma.journalEntry.count({ where: { sourceId: workOrder.id } })).toBe(0);
    });

    it("reverses and reposts an approved one, keeping its number", async () => {
      const workOrder = await draft("9000.00");
      const { workOrder: approved } = await approveWorkOrder({
        companyId: fixture.company.id,
        workOrderId: workOrder.id,
        userId: owner.id,
        role: "OWNER",
      });
      expect((await systemBalance(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE)).toFixed(2)).toBe("9000.00");

      await updateWorkOrder({
        companyId: fixture.company.id,
        workOrderId: workOrder.id,
        lines: [
          { description: "Work", quantity: "1", rate: "7000.00", accountId: fixture.code("5000").id },
        ],
        userId: owner.id,
        role: "OWNER",
      });

      const fresh = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } });
      expect(fresh.workOrderNumber).toBe(approved.workOrderNumber);
      expect(fresh.status).toBe("APPROVED");
      expect(money(fresh.total).toFixed(2)).toBe("7000.00");
      expect((await systemBalance(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE)).toFixed(2)).toBe("7000.00");
      expect((await balance("5000")).toFixed(2)).toBe("7000.00");
      await expectTies();
    });
  });

  describe("invoices", () => {
    async function draftInvoice(rate: string) {
      const customer = await makeCustomer(fixture.company.id, { name: "Acme" });
      return makeDraftInvoice({
        companyId: fixture.company.id,
        customerId: customer.id,
        currency: "PHP",
        issueDate: AUG,
        lines: [
          { description: "Consulting", quantity: "1", rate, incomeAccountId: fixture.code("4000").id },
        ],
      });
    }

    it("edits a draft freely", async () => {
      const invoice = await draftInvoice("10000.00");
      const updated = await updateInvoice({
        companyId: fixture.company.id,
        invoiceId: invoice.id,
        lines: [
          { description: "Consulting", quantity: "3", rate: "4000.00", incomeAccountId: fixture.code("4000").id },
        ],
        userId: owner.id,
        role: "OWNER",
      });
      expect(updated.status).toBe("DRAFT");
      expect(money(updated.total).toFixed(2)).toBe("12000.00");
      expect(await prisma.journalEntry.count({ where: { sourceId: invoice.id } })).toBe(0);
    });

    it("reverses and reposts an issued one, keeping its number", async () => {
      const invoice = await draftInvoice("10000.00");
      const { invoice: issued } = await issueInvoice({
        companyId: fixture.company.id,
        invoiceId: invoice.id,
        userId: owner.id,
        role: "OWNER",
      });
      expect((await systemBalance(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE)).toFixed(2)).toBe("10000.00");

      await updateInvoice({
        companyId: fixture.company.id,
        invoiceId: invoice.id,
        lines: [
          { description: "Consulting", quantity: "1", rate: "8000.00", incomeAccountId: fixture.code("4000").id },
        ],
        userId: owner.id,
        role: "OWNER",
      });

      const fresh = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(fresh.invoiceNumber).toBe(issued.invoiceNumber);
      expect(fresh.status).toBe("ISSUED");
      expect((await systemBalance(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE)).toFixed(2)).toBe("8000.00");
      expect((await balance("4000")).toFixed(2)).toBe("8000.00");
      await expectTies();
    });

    it("refuses an invoice with a payment against it", async () => {
      const invoice = await draftInvoice("10000.00");
      const { invoice: issued } = await issueInvoice({
        companyId: fixture.company.id,
        invoiceId: invoice.id,
        userId: owner.id,
        role: "OWNER",
      });
      await recordPayment({
        companyId: fixture.company.id,
        customerId: issued.customerId,
        date: AUG,
        amount: "4000.00",
        currency: "PHP",
        depositAccountId: fixture.code("1000").id,
        applications: [{ invoiceId: invoice.id, amountApplied: "4000.00" }],
        userId: owner.id,
        role: "OWNER",
      });

      await expect(
        updateInvoice({
          companyId: fixture.company.id,
          invoiceId: invoice.id,
          lines: [
            { description: "X", quantity: "1", rate: "1.00", incomeAccountId: fixture.code("4000").id },
          ],
          userId: owner.id,
          role: "OWNER",
        }),
      ).rejects.toThrow(/payments applied/);
    });
  });

  describe("sales orders", () => {
    async function draftOrder(rate: string) {
      const customer = await makeCustomer(fixture.company.id, { name: "Acme" });
      return prisma.salesOrder.create({
        data: {
          companyId: fixture.company.id,
          customerId: customer.id,
          orderDate: AUG,
          currency: "PHP",
          fxRate: "1",
          lines: {
            create: [
              {
                lineNumber: 1,
                description: "Widgets",
                quantity: "1",
                rate,
                amount: rate,
                incomeAccountId: fixture.code("4000").id,
              },
            ],
          },
        },
      });
    }

    it("edits a confirmed order, since it posts nothing", async () => {
      const order = await draftOrder("2000.00");
      await confirmSalesOrder({ companyId: fixture.company.id, salesOrderId: order.id });

      const updated = await updateSalesOrder({
        companyId: fixture.company.id,
        salesOrderId: order.id,
        lines: [
          { description: "Widgets", quantity: "4", rate: "600.00", incomeAccountId: fixture.code("4000").id },
        ],
      });

      expect(updated.status).toBe("CONFIRMED");
      expect(money(updated.total).toFixed(2)).toBe("2400.00");
      expect(await prisma.journalEntry.count()).toBe(0);
    });
  });

  describe("bill payments", () => {
    it("moves the amount and re-relieves the work order", async () => {
      const consultant = await makeVendor(fixture.company.id, "CONSULTANT");
      const workOrder = await prisma.workOrder.create({
        data: {
          companyId: fixture.company.id,
          vendorId: consultant.id,
          issueDate: AUG,
          dueDate: AUG,
          currency: "PHP",
          fxRate: "1",
          lines: {
            create: [
              {
                lineNumber: 1,
                description: "Work",
                quantity: "1",
                rate: "9000.00",
                amount: "9000.00",
                accountId: fixture.code("5000").id,
              },
            ],
          },
        },
      });
      await approveWorkOrder({
        companyId: fixture.company.id,
        workOrderId: workOrder.id,
        userId: owner.id,
        role: "OWNER",
      });

      const { payment } = await recordBillPayment({
        companyId: fixture.company.id,
        vendorId: consultant.id,
        date: AUG,
        amount: "4000.00",
        currency: "PHP",
        paymentAccountId: fixture.code("1000").id,
        applications: [{ workOrderId: workOrder.id, amountApplied: "4000.00" }],
        userId: owner.id,
        role: "OWNER",
      });

      // Up to 6,000 — more than the old payment, and only possible if the old
      // application was put back before the new one was measured.
      await updateBillPayment({
        companyId: fixture.company.id,
        billPaymentId: payment.id,
        date: AUG,
        amount: "6000.00",
        currency: "PHP",
        paymentAccountId: fixture.code("1000").id,
        applications: [{ workOrderId: workOrder.id, amountApplied: "6000.00" }],
        userId: owner.id,
        role: "OWNER",
      });

      const fresh = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } });
      expect(money(fresh.amountPaid).toFixed(2)).toBe("6000.00");
      expect(money(fresh.balanceDue).toFixed(2)).toBe("3000.00");
      expect(fresh.status).toBe("PARTIALLY_PAID");
      expect((await systemBalance(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE)).toFixed(2)).toBe("3000.00");
      expect((await balance("1000")).toFixed(2)).toBe("-6000.00");
      expect(
        await prisma.billPaymentApplication.count({ where: { billPaymentId: payment.id } }),
      ).toBe(1);
      await expectTies();
    });

    it("refuses one that has been reversed", async () => {
      const consultant = await makeVendor(fixture.company.id, "CONSULTANT");
      const { expense } = await recordExpense({
        companyId: fixture.company.id,
        kind: "BILL",
        vendorId: consultant.id,
        date: AUG,
        currency: "PHP",
        amount: "1000.00",
        expenseAccountId: fixture.code("6100").id,
        description: "Bill",
        userId: owner.id,
        role: "OWNER",
      });
      const { payment } = await recordBillPayment({
        companyId: fixture.company.id,
        vendorId: consultant.id,
        date: AUG,
        amount: "1000.00",
        currency: "PHP",
        paymentAccountId: fixture.code("1000").id,
        applications: [{ expenseId: expense.id, amountApplied: "1000.00" }],
        userId: owner.id,
        role: "OWNER",
      });
      await reverseBillPayment({
        companyId: fixture.company.id,
        billPaymentId: payment.id,
        date: AUG,
        userId: owner.id,
        role: "OWNER",
      });

      await expect(
        updateBillPayment({
          companyId: fixture.company.id,
          billPaymentId: payment.id,
          date: AUG,
          amount: "500.00",
          currency: "PHP",
          paymentAccountId: fixture.code("1000").id,
          applications: [{ expenseId: expense.id, amountApplied: "500.00" }],
          userId: owner.id,
          role: "OWNER",
        }),
      ).rejects.toThrow(/has been reversed/);
    });
  });

  describe("customer payments", () => {
    it("moves the amount and re-relieves the invoice", async () => {
      const customer = await makeCustomer(fixture.company.id, { name: "Acme" });
      const invoice = await makeDraftInvoice({
        companyId: fixture.company.id,
        customerId: customer.id,
        currency: "PHP",
        issueDate: AUG,
        lines: [
          { description: "Work", quantity: "1", rate: "10000.00", incomeAccountId: fixture.code("4000").id },
        ],
      });
      await issueInvoice({
        companyId: fixture.company.id,
        invoiceId: invoice.id,
        userId: owner.id,
        role: "OWNER",
      });

      const { payment } = await recordPayment({
        companyId: fixture.company.id,
        customerId: customer.id,
        date: AUG,
        amount: "3000.00",
        currency: "PHP",
        depositAccountId: fixture.code("1000").id,
        applications: [{ invoiceId: invoice.id, amountApplied: "3000.00" }],
        userId: owner.id,
        role: "OWNER",
      });

      await updatePayment({
        companyId: fixture.company.id,
        paymentId: payment.id,
        date: AUG,
        amount: "7500.00",
        currency: "PHP",
        depositAccountId: fixture.code("1000").id,
        applications: [{ invoiceId: invoice.id, amountApplied: "7500.00" }],
        userId: owner.id,
        role: "OWNER",
      });

      const fresh = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(money(fresh.amountPaid).toFixed(2)).toBe("7500.00");
      expect(money(fresh.balanceDue).toFixed(2)).toBe("2500.00");
      expect(fresh.status).toBe("PARTIALLY_PAID");
      expect((await systemBalance(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE)).toFixed(2)).toBe("2500.00");
      expect((await balance("1000")).toFixed(2)).toBe("7500.00");
      await expectTies();
    });
  });

  it("refuses to reach a document in another company", async () => {
    const other = await makeCompanyWithChart("Other Co");
    const { expense } = await recordExpense({
      companyId: fixture.company.id,
      kind: "DIRECT",
      date: AUG,
      currency: "PHP",
      amount: "100.00",
      expenseAccountId: fixture.code("6100").id,
      paymentAccountId: fixture.code("1000").id,
      description: "Mine",
      userId: owner.id,
      role: "OWNER",
    });

    await expect(
      updateExpense({
        companyId: other.company.id,
        expenseId: expense.id,
        date: AUG,
        currency: "PHP",
        amount: "200.00",
        expenseAccountId: other.code("6100").id,
        paymentAccountId: other.code("1000").id,
        description: "Theirs",
        userId: owner.id,
        role: "OWNER",
      }),
    ).rejects.toThrow(/not found in this company/);
  });
});
