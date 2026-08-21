import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  cancelSalesOrder,
  computeSalesOrderLine,
  confirmSalesOrder,
  convertToInvoice,
  deleteDraftSalesOrder,
} from "@/lib/invoices/sales-orders";
import { issueInvoice } from "@/lib/invoices/service";
import { salesByCustomer } from "@/lib/reports/sales-by-customer";
import { profitAndLoss } from "@/lib/reports/profit-loss";
import { makeCompanyWithChart, makeCustomer, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

/** SPEC §7.1a: a sales order records intent and posts nothing. */
describe("sales orders", () => {
  let fixture: Fixture;
  let customer: Awaited<ReturnType<typeof makeCustomer>>;

  const draftOrder = async (rate = "40000.00") =>
    prisma.salesOrder.create({
      data: {
        companyId: fixture.company.id,
        customerId: customer.id,
        orderDate: new Date(Date.UTC(2026, 5, 1)),
        currency: "PHP",
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "Retainer for July",
              quantity: "1",
              rate,
              amount: computeSalesOrderLine({ quantity: "1", rate }),
              incomeAccountId: fixture.code("4000").id,
            },
          ],
        },
      },
    });

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Orders Co", "PHP");
    customer = await makeCustomer(fixture.company.id, { name: "Acme" });
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("confirms with a number and still posts nothing", async () => {
    const order = await draftOrder();
    const confirmed = await confirmSalesOrder({
      companyId: fixture.company.id,
      salesOrderId: order.id,
    });

    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.orderNumber).toBe("SO1001");
    expect(confirmed.total.toFixed(2)).toBe("40000.00");

    // The whole point: no revenue until an invoice is issued.
    expect(await prisma.journalEntry.count({ where: { companyId: fixture.company.id } })).toBe(0);
    const pl = await profitAndLoss({
      companyId: fixture.company.id,
      from: new Date(Date.UTC(2026, 0, 1)),
      to: new Date(Date.UTC(2026, 11, 31)),
    });
    expect(pl.income.toFixed(2)).toBe("0.00");
  });

  it("converts to a DRAFT invoice, and only issuing that posts", async () => {
    const order = await draftOrder();
    await confirmSalesOrder({ companyId: fixture.company.id, salesOrderId: order.id });

    const invoice = await convertToInvoice({
      companyId: fixture.company.id,
      salesOrderId: order.id,
      issueDate: new Date(Date.UTC(2026, 6, 1)),
    });

    expect(invoice.status).toBe("DRAFT");
    expect(invoice.invoiceNumber).toBeNull();
    expect(invoice.salesOrderId).toBe(order.id);
    expect(invoice.lines[0].description).toBe("Retainer for July");
    expect(await prisma.journalEntry.count()).toBe(0);

    const updated = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe("INVOICED");

    // Now revenue exists.
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });
    const pl = await profitAndLoss({
      companyId: fixture.company.id,
      from: new Date(Date.UTC(2026, 0, 1)),
      to: new Date(Date.UTC(2026, 11, 31)),
    });
    expect(pl.income.toFixed(2)).toBe("40000.00");
  });

  it("refuses to invoice a draft, or to invoice twice", async () => {
    const order = await draftOrder();
    await expect(
      convertToInvoice({
        companyId: fixture.company.id,
        salesOrderId: order.id,
        issueDate: new Date(Date.UTC(2026, 6, 1)),
      }),
    ).rejects.toThrow(/Confirm the order/);

    await confirmSalesOrder({ companyId: fixture.company.id, salesOrderId: order.id });
    await convertToInvoice({
      companyId: fixture.company.id,
      salesOrderId: order.id,
      issueDate: new Date(Date.UTC(2026, 6, 1)),
    });
    await expect(
      convertToInvoice({
        companyId: fixture.company.id,
        salesOrderId: order.id,
        issueDate: new Date(Date.UTC(2026, 6, 2)),
      }),
    ).rejects.toThrow(/already been invoiced/);
  });

  it("cancels an order, but not one already invoiced", async () => {
    const order = await draftOrder();
    await confirmSalesOrder({ companyId: fixture.company.id, salesOrderId: order.id });
    const cancelled = await cancelSalesOrder({
      companyId: fixture.company.id,
      salesOrderId: order.id,
    });
    expect(cancelled.status).toBe("CANCELLED");

    const second = await draftOrder();
    await confirmSalesOrder({ companyId: fixture.company.id, salesOrderId: second.id });
    await convertToInvoice({
      companyId: fixture.company.id,
      salesOrderId: second.id,
      issueDate: new Date(Date.UTC(2026, 6, 1)),
    });
    await expect(
      cancelSalesOrder({ companyId: fixture.company.id, salesOrderId: second.id }),
    ).rejects.toThrow(/Void the invoice instead/);
  });

  it("deletes a draft but never a confirmed order", async () => {
    const order = await draftOrder();
    await deleteDraftSalesOrder(fixture.company.id, order.id);
    expect(await prisma.salesOrder.count()).toBe(0);

    const second = await draftOrder();
    await confirmSalesOrder({ companyId: fixture.company.id, salesOrderId: second.id });
    await expect(deleteDraftSalesOrder(fixture.company.id, second.id)).rejects.toThrow(
      /Only a draft/,
    );
  });

  it("stays inside its company", async () => {
    const other = await makeCompanyWithChart("Elsewhere", "USD");
    const order = await draftOrder();
    await expect(
      confirmSalesOrder({ companyId: other.company.id, salesOrderId: order.id }),
    ).rejects.toThrow(/not found in this company/);
  });
});

describe("sales by customer (SPEC §12.8)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Sales Co", "PHP");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("totals invoiced, paid and outstanding per customer in base currency", async () => {
    const { makeDraftInvoice } = await import("./helpers");
    const { recordPayment } = await import("@/lib/invoices/payments");

    const local = await makeCustomer(fixture.company.id, { name: "Cebu Retail" });
    const overseas = await makeCustomer(fixture.company.id, {
      name: "Northwind",
      currency: "USD",
    });

    const first = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: local.id,
      currency: "PHP",
      issueDate: new Date(Date.UTC(2026, 5, 5)),
      lines: [
        { description: "Work", quantity: "1", rate: "50000.00", incomeAccountId: fixture.code("4000").id },
      ],
    });
    await issueInvoice({ companyId: fixture.company.id, invoiceId: first.id });
    await recordPayment({
      companyId: fixture.company.id,
      customerId: local.id,
      date: new Date(Date.UTC(2026, 5, 20)),
      amount: "20000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: first.id, amountApplied: "20000.00" }],
    });

    // A USD invoice is reported in base currency at its own rate.
    const second = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: overseas.id,
      currency: "USD",
      fxRate: "58.00",
      issueDate: new Date(Date.UTC(2026, 5, 10)),
      lines: [
        { description: "Work", quantity: "1", rate: "1000.00", incomeAccountId: fixture.code("4000").id },
      ],
    });
    await issueInvoice({ companyId: fixture.company.id, invoiceId: second.id });

    const report = await salesByCustomer({
      companyId: fixture.company.id,
      from: new Date(Date.UTC(2026, 5, 1)),
      to: new Date(Date.UTC(2026, 5, 30)),
    });

    // Sorted by how much each customer was invoiced.
    expect(report.rows.map((row) => row.customerName)).toEqual(["Northwind", "Cebu Retail"]);

    const northwind = report.rows[0];
    expect(northwind.invoiced.toFixed(2)).toBe("58000.00");
    expect(northwind.outstanding.toFixed(2)).toBe("58000.00");

    const cebu = report.rows[1];
    expect(cebu.invoiced.toFixed(2)).toBe("50000.00");
    expect(cebu.paid.toFixed(2)).toBe("20000.00");
    expect(cebu.outstanding.toFixed(2)).toBe("30000.00");

    expect(report.totals.invoiced.toFixed(2)).toBe("108000.00");
  });

  it("leaves drafts and voids out — neither is a sale", async () => {
    const { makeDraftInvoice } = await import("./helpers");
    const { voidInvoice } = await import("@/lib/invoices/service");
    const customer = await makeCustomer(fixture.company.id, { name: "Acme" });

    // A draft.
    await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: new Date(Date.UTC(2026, 5, 5)),
      lines: [
        { description: "Work", quantity: "1", rate: "1000.00", incomeAccountId: fixture.code("4000").id },
      ],
    });

    // And an issued invoice that gets voided.
    const voided = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: new Date(Date.UTC(2026, 5, 6)),
      lines: [
        { description: "Work", quantity: "1", rate: "2000.00", incomeAccountId: fixture.code("4000").id },
      ],
    });
    await issueInvoice({ companyId: fixture.company.id, invoiceId: voided.id });
    await voidInvoice({
      companyId: fixture.company.id,
      invoiceId: voided.id,
      date: new Date(Date.UTC(2026, 5, 7)),
    });

    const report = await salesByCustomer({
      companyId: fixture.company.id,
      from: new Date(Date.UTC(2026, 5, 1)),
      to: new Date(Date.UTC(2026, 5, 30)),
    });
    expect(report.rows).toHaveLength(0);
  });
});
