import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  cancelPurchaseOrder,
  deletePurchaseOrder,
  issuePurchaseOrder,
  receivePurchaseOrder,
  updatePurchaseOrder,
} from "@/lib/payables/purchase-orders";
import {
  commitPurchaseOrderImport,
  stagePurchaseOrderImport,
} from "@/lib/imports/purchase-orders";
import { planBulkSend, queueBulkSend, processBatch } from "@/lib/email/bulk-send";
import { trialBalance } from "@/lib/ledger/reports";
import { balancesByAccount } from "@/lib/reports/balances";
import { makeCompanyWithChart, makeUser, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

let fixture: Fixture;
let owner: Awaited<ReturnType<typeof makeUser>>;
let vendor: Awaited<ReturnType<typeof prisma.vendor.create>>;

const ORDER_DATE = new Date("2025-07-10");
const YEAR_END = new Date("2025-12-31");

beforeEach(async () => {
  await resetDatabase();
  fixture = await makeCompanyWithChart("KASAGAMI APARTMENTS");
  owner = await makeUser("OWNER", fixture.company.id);
  vendor = await prisma.vendor.create({
    data: {
      companyId: fixture.company.id,
      kind: "REGULAR",
      name: "CARMEN COCO LUMBER",
      email: "orders@carmen.example",
      defaultCurrency: "PHP",
      paymentTermsDays: 30,
    },
  });
});

/** A draft order for two things, both coded to the same account. */
async function draft(options: { accountIds?: [string, string] } = {}) {
  const [first, second] = options.accountIds ?? [
    fixture.code("6100").id,
    fixture.code("6100").id,
  ];
  return prisma.purchaseOrder.create({
    data: {
      companyId: fixture.company.id,
      vendorId: vendor.id,
      orderDate: ORDER_DATE,
      expectedDate: new Date("2025-07-20"),
      currency: "PHP",
      shipTo: "Site 2, Davao",
      memo: "Framing materials",
      total: "13000.00",
      lines: {
        create: [
          {
            lineNumber: 1,
            description: "Coco lumber 2x3",
            quantity: "100",
            rate: "100.00",
            amount: "10000.00",
            expenseAccountId: first,
          },
          {
            lineNumber: 2,
            description: "Plywood 1/4",
            quantity: "10",
            rate: "300.00",
            amount: "3000.00",
            expenseAccountId: second,
          },
        ],
      },
    },
    include: { lines: true },
  });
}

async function balanceOf(accountId: string) {
  const rows = await balancesByAccount({ companyId: fixture.company.id, to: YEAR_END });
  return rows.find((row) => row.accountId === accountId)?.amount.toFixed(2) ?? "0.00";
}

describe("a purchase order posts nothing (SPEC §8.1a)", () => {
  it("is issued with a number, and the ledger stays empty", async () => {
    const order = await draft();
    expect(await prisma.journalEntry.count()).toBe(0);

    const issued = await issuePurchaseOrder({
      companyId: fixture.company.id,
      purchaseOrderId: order.id,
    });

    expect(issued.status).toBe("ISSUED");
    expect(issued.orderNumber).toMatch(/^PO\d+$/);
    expect(issued.issuedAt).not.toBeNull();
    expect(issued.total.toFixed(2)).toBe("13000.00");

    // The whole point: nothing has been posted and nothing is owed.
    expect(await prisma.journalEntry.count()).toBe(0);
    expect(await balanceOf(fixture.code("6100").id)).toBe("0.00");
    expect(await prisma.expense.count()).toBe(0);
  });

  it("refuses to issue a draft with no lines, or to issue twice", async () => {
    const empty = await prisma.purchaseOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: vendor.id,
        orderDate: ORDER_DATE,
        currency: "PHP",
      },
    });
    await expect(
      issuePurchaseOrder({ companyId: fixture.company.id, purchaseOrderId: empty.id }),
    ).rejects.toThrow(/at least one line/i);

    const order = await draft();
    await issuePurchaseOrder({ companyId: fixture.company.id, purchaseOrderId: order.id });
    await expect(
      issuePurchaseOrder({ companyId: fixture.company.id, purchaseOrderId: order.id }),
    ).rejects.toThrow(/only a draft/i);
  });

  it("can still be changed after issuing, because an order is a request", async () => {
    const order = await draft();
    await issuePurchaseOrder({ companyId: fixture.company.id, purchaseOrderId: order.id });

    const updated = await updatePurchaseOrder({
      companyId: fixture.company.id,
      purchaseOrderId: order.id,
      lines: [
        {
          description: "Coco lumber 2x3",
          quantity: "120",
          rate: "100.00",
          expenseAccountId: fixture.code("6100").id,
        },
      ],
    });
    expect(updated.lines).toHaveLength(1);
    expect(updated.total.toFixed(2)).toBe("12000.00");
  });
});

describe("receiving turns it into a bill (SPEC §8.1a)", () => {
  it("records the bill, links the two, and that is what posts", async () => {
    const order = await draft();
    await issuePurchaseOrder({ companyId: fixture.company.id, purchaseOrderId: order.id });

    const bill = await receivePurchaseOrder({
      companyId: fixture.company.id,
      purchaseOrderId: order.id,
      date: new Date("2025-07-22"),
      dueDate: new Date("2025-08-21"),
      reference: "CCL-8841",
      userId: owner.id,
      role: "OWNER",
    });

    expect(bill.kind).toBe("BILL");
    expect(bill.reference).toBe("CCL-8841");
    expect(bill.amount.toFixed(2)).toBe("13000.00");
    expect(bill.purchaseOrderId).toBe(order.id);

    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("RECEIVED");
    expect(after.receivedAt).not.toBeNull();

    // Now — and only now — the ledger has it, as an ordinary payable.
    expect(await balanceOf(fixture.code("6100").id)).toBe("13000.00");
    // Payables read as a positive balance in their own normal direction.
    expect(await balanceOf(fixture.system("ACCOUNTS_PAYABLE").id)).toBe("13000.00");
    const tb = await trialBalance({ companyId: fixture.company.id, asOf: YEAR_END });
    expect(tb.totalDebit.toFixed(2)).toBe(tb.totalCredit.toFixed(2));
  });

  it("refuses to receive a draft, a cancelled order, or the same order twice", async () => {
    const stillDraft = await draft();
    await expect(
      receivePurchaseOrder({
        companyId: fixture.company.id,
        purchaseOrderId: stillDraft.id,
        date: ORDER_DATE,
        reference: "X-1",
      }),
    ).rejects.toThrow(/issue the order/i);

    const order = await draft();
    await issuePurchaseOrder({ companyId: fixture.company.id, purchaseOrderId: order.id });
    await receivePurchaseOrder({
      companyId: fixture.company.id,
      purchaseOrderId: order.id,
      date: ORDER_DATE,
      reference: "CCL-1",
      userId: owner.id,
      role: "OWNER",
    });
    await expect(
      receivePurchaseOrder({
        companyId: fixture.company.id,
        purchaseOrderId: order.id,
        date: ORDER_DATE,
        reference: "CCL-2",
      }),
    ).rejects.toThrow(/already been received/i);
    // One bill, not two.
    expect(await prisma.expense.count({ where: { companyId: fixture.company.id } })).toBe(1);

    const doomed = await draft();
    await issuePurchaseOrder({ companyId: fixture.company.id, purchaseOrderId: doomed.id });
    await cancelPurchaseOrder({ companyId: fixture.company.id, purchaseOrderId: doomed.id });
    await expect(
      receivePurchaseOrder({
        companyId: fixture.company.id,
        purchaseOrderId: doomed.id,
        date: ORDER_DATE,
        reference: "X-2",
      }),
    ).rejects.toThrow(/cancelled/i);
  });

  it("asks which account when the lines are coded to several", async () => {
    const order = await draft({ accountIds: [fixture.code("6100").id, fixture.code("6200").id] });
    await issuePurchaseOrder({ companyId: fixture.company.id, purchaseOrderId: order.id });

    await expect(
      receivePurchaseOrder({
        companyId: fixture.company.id,
        purchaseOrderId: order.id,
        date: ORDER_DATE,
        reference: "CCL-3",
      }),
    ).rejects.toThrow(/more than one account/i);

    const bill = await receivePurchaseOrder({
      companyId: fixture.company.id,
      purchaseOrderId: order.id,
      date: ORDER_DATE,
      reference: "CCL-3",
      expenseAccountId: fixture.code("6200").id,
      userId: owner.id,
      role: "OWNER",
    });
    expect(bill.expenseAccountId).toBe(fixture.code("6200").id);
  });

  it("will not cancel or delete one that has become a bill", async () => {
    const order = await draft();
    await issuePurchaseOrder({ companyId: fixture.company.id, purchaseOrderId: order.id });
    await receivePurchaseOrder({
      companyId: fixture.company.id,
      purchaseOrderId: order.id,
      date: ORDER_DATE,
      reference: "CCL-4",
      userId: owner.id,
      role: "OWNER",
    });

    await expect(
      cancelPurchaseOrder({ companyId: fixture.company.id, purchaseOrderId: order.id }),
    ).rejects.toThrow(/void its bill/i);
    await expect(
      deletePurchaseOrder({ companyId: fixture.company.id, purchaseOrderId: order.id }),
    ).rejects.toThrow(/become a bill/i);
  });

  it("will not reach another company's order", async () => {
    const order = await draft();
    const other = await makeCompanyWithChart("THE PICKLE FARM");
    await expect(
      issuePurchaseOrder({ companyId: other.company.id, purchaseOrderId: order.id }),
    ).rejects.toThrow(/not found/i);
    await expect(
      receivePurchaseOrder({
        companyId: other.company.id,
        purchaseOrderId: order.id,
        date: ORDER_DATE,
        reference: "X",
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("sending purchase orders to vendors (SPEC §10.1)", () => {
  it("plans one email per order, and says who cannot be emailed", async () => {
    const order = await draft();
    await issuePurchaseOrder({ companyId: fixture.company.id, purchaseOrderId: order.id });

    const silent = await prisma.vendor.create({
      data: {
        companyId: fixture.company.id,
        kind: "REGULAR",
        name: "NO EMAIL HARDWARE",
        defaultCurrency: "PHP",
      },
    });
    const second = await prisma.purchaseOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: silent.id,
        orderDate: ORDER_DATE,
        currency: "PHP",
        total: "500.00",
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "Nails",
              quantity: "5",
              rate: "100.00",
              amount: "500.00",
              expenseAccountId: fixture.code("6100").id,
            },
          ],
        },
      },
    });
    await issuePurchaseOrder({ companyId: fixture.company.id, purchaseOrderId: second.id });

    const plan = await planBulkSend({
      companyId: fixture.company.id,
      kind: "PURCHASE_ORDER",
      documentIds: [order.id, second.id],
      groupByConsultant: false,
    });

    expect(plan.emailCount).toBe(1);
    expect(plan.excluded).toHaveLength(1);
    expect(plan.excluded[0].consultantName).toBe("NO EMAIL HARDWARE");
    expect(plan.excluded[0].excludedReason).toMatch(/no email address/i);
    // The template is the purchase order one, with the order's own number.
    expect(plan.subjectSample).toMatch(/^Purchase order PO\d+ from/);
  });

  it("sends, stamps the order and records the batch", async () => {
    const order = await draft();
    const issued = await issuePurchaseOrder({
      companyId: fixture.company.id,
      purchaseOrderId: order.id,
    });

    const { batchId } = await queueBulkSend({
      companyId: fixture.company.id,
      kind: "PURCHASE_ORDER",
      documentIds: [order.id],
      groupByConsultant: false,
      userId: owner.id,
    });
    await processBatch(fixture.company.id, batchId);

    const batch = await prisma.emailBatch.findUniqueOrThrow({
      where: { id: batchId },
      include: { items: true },
    });
    expect(batch.kind).toBe("PURCHASE_ORDER");
    expect(batch.items[0].documentIds).toEqual([order.id]);
    expect(batch.sentCount).toBe(1);

    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.lastEmailedAt).not.toBeNull();
    expect(after.orderNumber).toBe(issued.orderNumber);

    const log = await prisma.emailLog.findFirst({ where: { companyId: fixture.company.id } });
    expect(log?.relatedType).toBe("PurchaseOrder");
  });
});

describe("importing a sheet of purchase orders (SPEC §8.3)", () => {
  async function workbook(rows: (string | number)[][]): Promise<Buffer> {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("ORDERS");
    sheet.addRow(["ORDER DATE", "VENDOR", "LINE NO", "DESCRIPTION", "ACCOUNT", "QTY", "RATE"]);
    for (const row of rows) sheet.addRow(row);
    return Buffer.from(await book.xlsx.writeBuffer());
  }

  it("reads a vendor's sheet and makes drafts, posting nothing", async () => {
    const staged = await stagePurchaseOrderImport({
      companyId: fixture.company.id,
      fileName: "orders.xlsx",
      bytes: await workbook([
        ["7/10/2025", "CARMEN COCO LUMBER", 1, "Coco lumber", "6100", 100, 100],
        ["7/10/2025", "CARMEN COCO LUMBER", 2, "Plywood", "6100", 10, 300],
      ]),
      userId: owner.id,
    });

    expect(staged.validation.workOrders).toHaveLength(1);
    expect(await prisma.purchaseOrder.count()).toBe(0);

    const committed = await commitPurchaseOrderImport({
      companyId: fixture.company.id,
      batchId: staged.batchId,
      userId: owner.id,
    });
    expect(committed.purchaseOrderCount).toBe(1);

    const order = await prisma.purchaseOrder.findFirstOrThrow({
      where: { companyId: fixture.company.id },
      include: { lines: true },
    });
    expect(order.status).toBe("DRAFT");
    expect(order.vendorId).toBe(vendor.id);
    expect(order.lines).toHaveLength(2);
    expect(order.total.toFixed(2)).toBe("13000.00");
    // Still nothing in the ledger — these are orders, not bills.
    expect(await prisma.journalEntry.count()).toBe(0);
  });

  it("does not match a consultant's name from the vendors' sheet", async () => {
    await prisma.vendor.create({
      data: {
        companyId: fixture.company.id,
        kind: "CONSULTANT",
        name: "ABIGAIL BAUTISTA",
        defaultCurrency: "PHP",
      },
    });

    const staged = await stagePurchaseOrderImport({
      companyId: fixture.company.id,
      fileName: "orders.xlsx",
      bytes: await workbook([["7/10/2025", "ABIGAIL BAUTISTA", 1, "Consulting", "6100", 1, 500]]),
      userId: owner.id,
    });

    // A consultant is not a vendor: the row is unmatched rather than quietly
    // ordered from the wrong party.
    expect(staged.validation.workOrders).toHaveLength(0);
    expect(staged.validation.rows[0].issues.some((issue) => issue.severity === "error")).toBe(true);
  });
});
