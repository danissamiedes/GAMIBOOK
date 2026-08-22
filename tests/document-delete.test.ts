import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteInvoice, issueInvoice, whyNotDeletableInvoice } from "@/lib/invoices/service";
import { deletePayment, recordPayment } from "@/lib/invoices/payments";
import {
  approveWorkOrder,
  computeWorkOrderLine,
  deleteWorkOrder,
} from "@/lib/payables/work-orders";
import {
  confirmSalesOrder,
  convertToInvoice,
  deleteSalesOrder,
  whyNotDeletableSalesOrder,
} from "@/lib/invoices/sales-orders";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { accountBalance } from "@/lib/ledger/reports";
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

const DATE = new Date(Date.UTC(2026, 7, 15));
const AS_OF = new Date(Date.UTC(2026, 11, 31));

/**
 * Same-day delete across the documents that post (SPEC §4.2 rule 3 and its one
 * exception). Every case checks the ledger lands back where it started, not
 * just that a row went away.
 */
describe("deleting posted documents recorded by mistake", () => {
  let fixture: Fixture;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let other: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Ledger Co", "PHP");
    owner = await makeUser("OWNER", fixture.company.id);
    other = await makeUser("BOOKKEEPER", fixture.company.id, "someone-else@example.test");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const balanceOf = (accountId: string) =>
    accountBalance({ companyId: fixture.company.id, accountId, asOf: AS_OF });

  const ar = () => balanceOf(fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE).id);
  const ap = () => balanceOf(fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE).id);

  async function issuedInvoice(rate = "5000.00", userId = owner.id) {
    const customer = await makeCustomer(fixture.company.id);
    const draft = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: DATE,
      lines: [
        { description: "Consulting", quantity: "1", rate, incomeAccountId: fixture.code("4000").id },
      ],
    });
    const issued = await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: draft.id,
      userId,
      role: "OWNER",
    });
    return { customer, invoice: issued.invoice };
  }

  async function approvedWorkOrder(rate = "4000.00", userId = owner.id) {
    const consultant = await makeVendor(fixture.company.id, "CONSULTANT");
    const workOrder = await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: consultant.id,
        issueDate: DATE,
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
    await approveWorkOrder({
      companyId: fixture.company.id,
      workOrderId: workOrder.id,
      userId,
      role: "OWNER",
    });
    return { consultant, workOrder };
  }

  describe("an issued invoice", () => {
    it("comes out of receivables and takes its entry with it", async () => {
      const { invoice } = await issuedInvoice();
      expect((await ar()).toFixed(2)).toBe("5000.00");

      await deleteInvoice({
        companyId: fixture.company.id,
        invoiceId: invoice.id,
        userId: owner.id,
      });

      expect((await ar()).toFixed(2)).toBe("0.00");
      expect((await balanceOf(fixture.code("4000").id)).toFixed(2)).toBe("0.00");
      expect(await prisma.invoice.count()).toBe(0);
      expect(await prisma.invoiceLine.count()).toBe(0);
      expect(await prisma.journalEntry.count()).toBe(0);
    });

    it("keeps the invoice, its lines and its entry in the audit trail", async () => {
      const { invoice } = await issuedInvoice();
      await deleteInvoice({
        companyId: fixture.company.id,
        invoiceId: invoice.id,
        userId: owner.id,
      });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "invoice.deleted", entityId: invoice.id },
      });
      const data = audit.data as {
        invoice: { invoiceNumber: string; total: string; lines: unknown[] };
        entry: { lines: unknown[] };
      };
      expect(data.invoice.invoiceNumber).toBe(invoice.invoiceNumber);
      expect(data.invoice.total).toBe("5000.00");
      expect(data.invoice.lines).toHaveLength(1);
      expect(data.entry.lines).toHaveLength(2);
    });

    it("refuses one that has been emailed to the customer", async () => {
      const { invoice } = await issuedInvoice();
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { lastEmailedAt: new Date() },
      });

      await expect(
        deleteInvoice({ companyId: fixture.company.id, invoiceId: invoice.id, userId: owner.id }),
      ).rejects.toThrow(/emailed to the customer/);
      expect(await prisma.invoice.count()).toBe(1);
    });

    it("refuses one with a payment applied", async () => {
      const { customer, invoice } = await issuedInvoice();
      await recordPayment({
        companyId: fixture.company.id,
        customerId: customer.id,
        date: DATE,
        amount: "2000.00",
        currency: "PHP",
        depositAccountId: fixture.code("1000").id,
        applications: [{ invoiceId: invoice.id, amountApplied: "2000.00" }],
        userId: owner.id,
        role: "OWNER",
      });

      await expect(
        deleteInvoice({ companyId: fixture.company.id, invoiceId: invoice.id, userId: owner.id }),
      ).rejects.toThrow(/has payments applied/);
    });

    it("refuses someone else's", async () => {
      const { invoice } = await issuedInvoice();
      await expect(
        deleteInvoice({ companyId: fixture.company.id, invoiceId: invoice.id, userId: other.id }),
      ).rejects.toThrow(/Only the person who recorded an invoice/);
    });

    it("sends a draft to deleteDraftInvoice rather than erasing it", async () => {
      const customer = await makeCustomer(fixture.company.id);
      const draft = await makeDraftInvoice({
        companyId: fixture.company.id,
        customerId: customer.id,
        currency: "PHP",
        lines: [
          {
            description: "Consulting",
            quantity: "1",
            rate: "100.00",
            incomeAccountId: fixture.code("4000").id,
          },
        ],
      });
      expect(
        whyNotDeletableInvoice({
          invoice: { ...draft, applications: [] },
          entry: null,
          postings: 0,
          bankMatchCount: 0,
          booksClosedThrough: null,
          userId: owner.id,
        }),
      ).toMatch(/draft invoice is deleted/);
    });

    it("puts the sales order it came from back to confirmed", async () => {
      const customer = await makeCustomer(fixture.company.id);
      const order = await prisma.salesOrder.create({
        data: {
          companyId: fixture.company.id,
          customerId: customer.id,
          orderDate: DATE,
          currency: "PHP",
          fxRate: "1",
          lines: {
            create: [
              {
                lineNumber: 1,
                description: "Consulting",
                quantity: "1",
                rate: "5000.00",
                amount: "5000.00",
                incomeAccountId: fixture.code("4000").id,
              },
            ],
          },
        },
      });
      await confirmSalesOrder({ companyId: fixture.company.id, salesOrderId: order.id });
      const draft = await convertToInvoice({
        companyId: fixture.company.id,
        salesOrderId: order.id,
        issueDate: DATE,
      });
      const issued = await issueInvoice({
        companyId: fixture.company.id,
        invoiceId: draft.id,
        userId: owner.id,
        role: "OWNER",
      });

      await deleteInvoice({
        companyId: fixture.company.id,
        invoiceId: issued.invoice.id,
        userId: owner.id,
      });

      // Left as INVOICED it would be an order marked invoiced with no invoice,
      // and no way back to either state.
      const after = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.status).toBe("CONFIRMED");
    });
  });

  describe("a customer payment", () => {
    async function paidInvoice(userId = owner.id) {
      const { customer, invoice } = await issuedInvoice("5000.00");
      const payment = await recordPayment({
        companyId: fixture.company.id,
        customerId: customer.id,
        date: DATE,
        amount: "2000.00",
        currency: "PHP",
        depositAccountId: fixture.code("1000").id,
        applications: [{ invoiceId: invoice.id, amountApplied: "2000.00" }],
        userId,
        role: "OWNER",
      });
      return { customer, invoice, payment };
    }

    it("puts the invoice back to unpaid and the cash back", async () => {
      const { invoice, payment } = await paidInvoice();
      expect((await ar()).toFixed(2)).toBe("3000.00");

      await deletePayment({
        companyId: fixture.company.id,
        paymentId: payment.payment.id,
        userId: owner.id,
      });

      expect((await ar()).toFixed(2)).toBe("5000.00");
      expect((await balanceOf(fixture.code("1000").id)).toFixed(2)).toBe("0.00");

      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.amountPaid.toFixed(2)).toBe("0.00");
      expect(after.balanceDue.toFixed(2)).toBe("5000.00");
      expect(after.status).toBe("ISSUED");
      expect(await prisma.paymentApplication.count()).toBe(0);
      expect(await prisma.payment.count()).toBe(0);
    });

    it("keeps the payment and what it settled in the audit trail", async () => {
      const { invoice, payment } = await paidInvoice();
      await deletePayment({
        companyId: fixture.company.id,
        paymentId: payment.payment.id,
        userId: owner.id,
      });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "payment.deleted", entityId: payment.payment.id },
      });
      const data = audit.data as {
        payment: { amount: string };
        applications: { invoiceId: string; amountApplied: string }[];
      };
      expect(data.payment.amount).toBe("2000.00");
      expect(data.applications).toEqual([{ invoiceId: invoice.id, amountApplied: "2000.00" }]);
    });

    it("refuses someone else's", async () => {
      const { payment } = await paidInvoice();
      await expect(
        deletePayment({
          companyId: fixture.company.id,
          paymentId: payment.payment.id,
          userId: other.id,
        }),
      ).rejects.toThrow(/Only the person who recorded a payment/);
    });
  });

  describe("an approved work order", () => {
    it("comes out of payables and takes its entry with it", async () => {
      const { workOrder } = await approvedWorkOrder();
      expect((await ap()).toFixed(2)).toBe("4000.00");

      await deleteWorkOrder({
        companyId: fixture.company.id,
        workOrderId: workOrder.id,
        userId: owner.id,
      });

      expect((await ap()).toFixed(2)).toBe("0.00");
      expect(await prisma.workOrder.count()).toBe(0);
      expect(await prisma.workOrderLine.count()).toBe(0);
      expect(await prisma.journalEntry.count()).toBe(0);
    });

    it("refuses one that has been emailed to the consultant", async () => {
      const { workOrder } = await approvedWorkOrder();
      await prisma.workOrder.update({
        where: { id: workOrder.id },
        data: { lastEmailedAt: new Date() },
      });

      await expect(
        deleteWorkOrder({
          companyId: fixture.company.id,
          workOrderId: workOrder.id,
          userId: owner.id,
        }),
      ).rejects.toThrow(/emailed to the consultant/);
    });

    it("refuses someone else's", async () => {
      const { workOrder } = await approvedWorkOrder();
      await expect(
        deleteWorkOrder({
          companyId: fixture.company.id,
          workOrderId: workOrder.id,
          userId: other.id,
        }),
      ).rejects.toThrow(/Only the person who recorded a work order/);
    });
  });

  /*
   * The odd one out: a sales order posts nothing, so there is no entry to
   * erase, no window to be inside and no period to be closed against it. The
   * only rule is that nothing has been built on it.
   */
  describe("a sales order", () => {
    async function order(status: "DRAFT" | "CONFIRMED" = "CONFIRMED") {
      const customer = await makeCustomer(fixture.company.id);
      const created = await prisma.salesOrder.create({
        data: {
          companyId: fixture.company.id,
          customerId: customer.id,
          orderDate: DATE,
          currency: "PHP",
          fxRate: "1",
          lines: {
            create: [
              {
                lineNumber: 1,
                description: "Consulting",
                quantity: "1",
                rate: "5000.00",
                amount: "5000.00",
                incomeAccountId: fixture.code("4000").id,
              },
            ],
          },
        },
      });
      if (status === "CONFIRMED") {
        await confirmSalesOrder({ companyId: fixture.company.id, salesOrderId: created.id });
      }
      return created;
    }

    it("goes, with its lines, whoever recorded it and whenever", async () => {
      const created = await order();
      await deleteSalesOrder({
        companyId: fixture.company.id,
        salesOrderId: created.id,
        userId: other.id,
      });

      expect(await prisma.salesOrder.count()).toBe(0);
      expect(await prisma.salesOrderLine.count()).toBe(0);
      // Nothing was ever posted for it, so nothing in the ledger moved.
      expect(await prisma.journalEntry.count()).toBe(0);
    });

    it("keeps it in the audit trail", async () => {
      const created = await order();
      await deleteSalesOrder({
        companyId: fixture.company.id,
        salesOrderId: created.id,
        userId: owner.id,
      });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "salesOrder.deleted", entityId: created.id },
      });
      const data = audit.data as { salesOrder: { total: string; lines: unknown[] } };
      expect(data.salesOrder.total).toBe("5000.00");
      expect(data.salesOrder.lines).toHaveLength(1);
    });

    it("refuses once it has become an invoice", async () => {
      const created = await order();
      await convertToInvoice({
        companyId: fixture.company.id,
        salesOrderId: created.id,
        issueDate: DATE,
      });

      await expect(
        deleteSalesOrder({
          companyId: fixture.company.id,
          salesOrderId: created.id,
          userId: owner.id,
        }),
      ).rejects.toThrow(/has been invoiced/);
      expect(await prisma.salesOrder.count()).toBe(1);
    });

    it("says so from the gate too, so the list never offers the button", () => {
      expect(
        whyNotDeletableSalesOrder({ status: "INVOICED", invoice: { id: "inv-1" } }),
      ).toMatch(/has been invoiced/);
      expect(whyNotDeletableSalesOrder({ status: "CONFIRMED", invoice: null })).toBeNull();
    });

    it("refuses one from another company", async () => {
      const created = await order();
      const elsewhere = await makeCompanyWithChart("Other Co", "PHP");

      await expect(
        deleteSalesOrder({
          companyId: elsewhere.company.id,
          salesOrderId: created.id,
          userId: owner.id,
        }),
      ).rejects.toThrow(/not found in this company/);
    });
  });
});
