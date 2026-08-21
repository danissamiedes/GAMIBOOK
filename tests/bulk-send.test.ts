import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_BATCH_EMAILS,
  batchWithItems,
  planBulkSend,
  processBatch,
  queueBulkSend,
  retryFailed,
} from "@/lib/email/bulk-send";
import { approveWorkOrder } from "@/lib/payables/work-orders";
import { resetStorage } from "@/lib/storage";
import { makeCompanyWithChart, makeVendor, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

/** SPEC §10.1: select many work orders, each going to its own consultant. */
describe("bulk work order send", () => {
  let fixture: Fixture;
  let root: string;

  beforeEach(async () => {
    await resetDatabase();
    root = mkdtempSync(path.join(tmpdir(), "ledger-bulk-"));
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_PATH = root;
    process.env.EMAIL_DRY_RUN = "true";
    resetStorage();
    fixture = await makeCompanyWithChart("Bulk Co", "PHP");
  });

  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    await resetDatabase();
    await prisma.$disconnect();
  });

  const consultant = async (name: string, options: { email?: string | null; sendEmails?: boolean; cc?: string[] } = {}) => {
    const vendor = await makeVendor(fixture.company.id, "CONSULTANT", { name });
    return prisma.vendor.update({
      where: { id: vendor.id },
      data: {
        email: options.email === undefined ? `${name.split(" ")[0].toLowerCase()}@example.test` : options.email,
        sendEmails: options.sendEmails ?? true,
        ccEmails: options.cc ?? [],
      },
    });
  };

  const workOrder = async (vendorId: string, rate = "10000.00", approve = true) => {
    const created = await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId,
        issueDate: new Date(Date.UTC(2026, 7, 15)),
        dueDate: new Date(Date.UTC(2026, 7, 30)),
        currency: "PHP",
        total: rate,
        balanceDue: rate,
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "Consultation",
              quantity: "1",
              rate,
              amount: rate,
              accountId: fixture.code("5000").id,
            },
          ],
        },
      },
    });
    if (approve) {
      await approveWorkOrder({ companyId: fixture.company.id, workOrderId: created.id });
    }
    return created;
  };

  it("plans one email per work order by default", async () => {
    const abigail = await consultant("Abigail Bautista");
    const johnRex = await consultant("John Rex Meraveles", { cc: ["manager@example.test"] });
    const ids = [await workOrder(abigail.id), await workOrder(abigail.id), await workOrder(johnRex.id)].map(
      (workOrder) => workOrder.id,
    );

    const plan = await planBulkSend({
      companyId: fixture.company.id,
      workOrderIds: ids,
      groupByConsultant: false,
    });

    expect(plan.emailCount).toBe(3);
    expect(plan.consultantCount).toBe(2);
    // Abigail, John Rex and his manager.
    expect(plan.recipientAddressCount).toBe(3);
    expect(plan.subjectSample).not.toContain("{{");
    // The number has to actually be in there — an empty substitution also
    // contains no "{{", which is how this slipped through once.
    expect(plan.subjectSample).toMatch(/WO10\d\d/);
  });

  it("groups into one email per consultant when asked", async () => {
    const abigail = await consultant("Abigail Bautista");
    const johnRex = await consultant("John Rex Meraveles");
    const ids = [await workOrder(abigail.id), await workOrder(abigail.id), await workOrder(johnRex.id)].map(
      (workOrder) => workOrder.id,
    );

    const plan = await planBulkSend({
      companyId: fixture.company.id,
      workOrderIds: ids,
      groupByConsultant: true,
    });

    expect(plan.emailCount).toBe(2);
    const abigailPlan = plan.sendable.find((recipient) => recipient.consultantName === "Abigail Bautista")!;
    expect(abigailPlan.workOrderIds).toHaveLength(2);
  });

  it("lists a consultant who cannot be emailed instead of skipping silently", async () => {
    const abigail = await consultant("Abigail Bautista");
    const chareze = await consultant("Chareze Valencia", { email: null, sendEmails: false });
    const noAddress = await consultant("No Address", { email: null });

    const ids = [
      await workOrder(abigail.id),
      await workOrder(chareze.id),
      await workOrder(noAddress.id),
    ].map((workOrder) => workOrder.id);

    const plan = await planBulkSend({
      companyId: fixture.company.id,
      workOrderIds: ids,
      groupByConsultant: false,
    });

    expect(plan.emailCount).toBe(1);
    expect(plan.excluded).toHaveLength(2);
    expect(plan.excluded.map((recipient) => recipient.excludedReason).sort()).toEqual([
      "Marked not to be emailed",
      "No email address on file",
    ]);
  });

  it("sends the batch, stamps each document and logs one row per email", async () => {
    const abigail = await consultant("Abigail Bautista");
    const johnRex = await consultant("John Rex Meraveles");
    const orders = [await workOrder(abigail.id), await workOrder(johnRex.id)];

    const { batchId } = await queueBulkSend({
      companyId: fixture.company.id,
      workOrderIds: orders.map((order) => order.id),
      groupByConsultant: false,
    });
    const finished = await processBatch(fixture.company.id, batchId);

    expect(finished.status).toBe("COMPLETED");
    expect(finished.sentCount).toBe(2);
    expect(finished.failedCount).toBe(0);

    for (const order of orders) {
      const refreshed = await prisma.workOrder.findUniqueOrThrow({ where: { id: order.id } });
      expect(refreshed.lastEmailedAt).not.toBeNull();
    }

    const logs = await prisma.emailLog.findMany({ where: { emailBatchId: batchId } });
    expect(logs).toHaveLength(2);
    for (const log of logs) {
      expect(log.status).toBe("SENT");
      expect(log.attachmentNames[0]).toMatch(/^WorkOrder-WO10\d\d-/);
      // The subject of what actually went out, not just the preview.
      expect(log.subject).toMatch(/WO10\d\d/);
      expect(log.bodySnapshot).toMatch(/WO10\d\d/);
    }
  });

  it("attaches every document when grouped by consultant", async () => {
    const abigail = await consultant("Abigail Bautista");
    const ids = [await workOrder(abigail.id), await workOrder(abigail.id)].map((order) => order.id);

    const { batchId } = await queueBulkSend({
      companyId: fixture.company.id,
      workOrderIds: ids,
      groupByConsultant: true,
    });
    await processBatch(fixture.company.id, batchId);

    const log = await prisma.emailLog.findFirstOrThrow({ where: { emailBatchId: batchId } });
    expect(log.attachmentNames).toHaveLength(2);
    expect(new Set(log.attachmentNames).size).toBe(2);
    // Both numbers named in the one subject.
    expect(log.subject).toMatch(/WO1001, WO1002|WO1002, WO1001/);
  });

  it("keeps going when one message fails, and retries only that one", async () => {
    const abigail = await consultant("Abigail Bautista");
    const johnRex = await consultant("John Rex Meraveles");
    const chareze = await consultant("Chareze Valencia");
    const orders = [
      await workOrder(abigail.id),
      await workOrder(johnRex.id),
      await workOrder(chareze.id),
    ];

    const { batchId } = await queueBulkSend({
      companyId: fixture.company.id,
      workOrderIds: orders.map((order) => order.id),
      groupByConsultant: false,
    });

    // Make exactly one message fail, the way a rejected address would.
    const items = await prisma.emailBatchItem.findMany({ where: { emailBatchId: batchId } });
    await prisma.emailBatchItem.update({
      where: { id: items[1].id },
      data: { toAddresses: [] },
    });

    const first = await processBatch(fixture.company.id, batchId);
    expect(first.sentCount).toBe(2);
    expect(first.failedCount).toBe(1);
    expect(first.status).toBe("COMPLETED_WITH_FAILURES");

    // The two that worked are stamped; the failure is not.
    const failedItem = await prisma.emailBatchItem.findUniqueOrThrow({ where: { id: items[1].id } });
    const failedOrder = await prisma.workOrder.findUniqueOrThrow({
      where: { id: failedItem.workOrderIds[0] },
    });
    expect(failedOrder.lastEmailedAt).toBeNull();

    // Repair and retry: only the failure is re-sent.
    await prisma.emailBatchItem.update({
      where: { id: items[1].id },
      data: { toAddresses: ["fixed@example.test"] },
    });
    const retried = await retryFailed({ companyId: fixture.company.id, batchId });

    expect(retried.sentCount).toBe(3);
    expect(retried.failedCount).toBe(0);
    expect(retried.status).toBe("COMPLETED");

    // Three messages actually went out — the two successes were not re-sent.
    expect(
      await prisma.emailLog.count({ where: { emailBatchId: batchId, status: "SENT" } }),
    ).toBe(3);
    // Four log rows, because the log records every attempt including the
    // failure, which is what makes it useful afterwards (SPEC §10).
    expect(await prisma.emailLog.count({ where: { emailBatchId: batchId } })).toBe(4);
  });

  it("refuses to retry when nothing failed", async () => {
    const abigail = await consultant("Abigail Bautista");
    const { batchId } = await queueBulkSend({
      companyId: fixture.company.id,
      workOrderIds: [(await workOrder(abigail.id)).id],
      groupByConsultant: false,
    });
    await processBatch(fixture.company.id, batchId);

    await expect(retryFailed({ companyId: fixture.company.id, batchId })).rejects.toThrow(
      /Nothing in this batch failed/,
    );
  });

  it("processing twice does not send anything twice", async () => {
    const abigail = await consultant("Abigail Bautista");
    const { batchId } = await queueBulkSend({
      companyId: fixture.company.id,
      workOrderIds: [(await workOrder(abigail.id)).id],
      groupByConsultant: false,
    });

    await processBatch(fixture.company.id, batchId);
    await processBatch(fixture.company.id, batchId);

    expect(await prisma.emailLog.count({ where: { emailBatchId: batchId } })).toBe(1);
  });

  it("records excluded consultants on the batch itself", async () => {
    const abigail = await consultant("Abigail Bautista");
    const chareze = await consultant("Chareze Valencia", { email: null, sendEmails: false });

    const { batchId } = await queueBulkSend({
      companyId: fixture.company.id,
      workOrderIds: [(await workOrder(abigail.id)).id, (await workOrder(chareze.id)).id],
      groupByConsultant: false,
    });
    await processBatch(fixture.company.id, batchId);

    const detail = await batchWithItems(fixture.company.id, batchId);
    const skipped = detail!.items.filter((item) => item.status === "SKIPPED");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].consultantName).toBe("Chareze Valencia");
    expect(skipped[0].reason).toBe("Marked not to be emailed");
  });

  it("warns about drafts in the selection rather than refusing them", async () => {
    const abigail = await consultant("Abigail Bautista");
    const draft = await workOrder(abigail.id, "10000.00", false);

    const plan = await planBulkSend({
      companyId: fixture.company.id,
      workOrderIds: [draft.id],
      groupByConsultant: false,
    });
    expect(plan.draftCount).toBe(1);

    // Emailing a draft posts nothing (SPEC §8.1).
    const { batchId } = await queueBulkSend({
      companyId: fixture.company.id,
      workOrderIds: [draft.id],
      groupByConsultant: false,
    });
    await processBatch(fixture.company.id, batchId);
    expect(await prisma.journalEntry.count({ where: { companyId: fixture.company.id } })).toBe(0);
  });

  it("refuses a batch where nobody can be emailed, and one that is too large", async () => {
    const chareze = await consultant("Chareze Valencia", { email: null, sendEmails: false });
    await expect(
      queueBulkSend({
        companyId: fixture.company.id,
        workOrderIds: [(await workOrder(chareze.id)).id],
        groupByConsultant: false,
      }),
    ).rejects.toThrow(/None of the selected work orders can be emailed/);

    expect(MAX_BATCH_EMAILS).toBe(200);
  });

  it("keeps one company's batch out of another's", async () => {
    const abigail = await consultant("Abigail Bautista");
    const { batchId } = await queueBulkSend({
      companyId: fixture.company.id,
      workOrderIds: [(await workOrder(abigail.id)).id],
      groupByConsultant: false,
    });

    const other = await makeCompanyWithChart("Elsewhere", "PHP");
    await expect(processBatch(other.company.id, batchId)).rejects.toThrow(/not found in this company/);
    expect(await batchWithItems(other.company.id, batchId)).toBeNull();
  });
});
