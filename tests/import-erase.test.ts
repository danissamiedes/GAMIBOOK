import { beforeEach, describe, expect, it } from "vitest";
import type { ImportBatchStatus } from "@prisma/client";
import { deleteImportBatch, isDeletable } from "@/lib/imports/erase";
import { makeCompanyWithChart, makeUser, makeVendor, prisma, resetDatabase } from "./helpers";
import { withCompanyScope } from "@/lib/company-scope";

beforeEach(async () => {
  await resetDatabase();
});

async function setup() {
  const fixture = await makeCompanyWithChart("Import Co");
  const user = await makeUser("OWNER", fixture.company.id);
  const scope = await withCompanyScope(user.id, fixture.company.id);
  return { fixture, user, scope };
}

async function makeBatch(
  companyId: string,
  status: ImportBatchStatus,
  fileName = "work-orders.xlsx",
) {
  return prisma.importBatch.create({
    data: {
      companyId,
      kind: "WORK_ORDER",
      status,
      fileName,
      fileHash: `hash-${Math.random()}`,
      rowCount: 30,
    },
  });
}

describe("clearing failed imports out of the list (SPEC §8.3)", () => {
  it("only offers to remove a discarded batch", () => {
    expect(isDeletable("DISCARDED")).toBe(true);
    // A committed batch is provenance; a parsed one is unfinished work that
    // already has its own Discard button.
    expect(isDeletable("COMMITTED")).toBe(false);
    expect(isDeletable("PARSED")).toBe(false);
    expect(isDeletable("ROLLED_BACK")).toBe(false);
  });

  it("removes a discarded batch and the rows staged under it", async () => {
    const { fixture, scope } = await setup();
    const batch = await makeBatch(fixture.company.id, "DISCARDED");
    await prisma.importRow.create({
      data: { importBatchId: batch.id, rowNumber: 2, rawJson: {}, status: "ERROR" },
    });

    const result = await deleteImportBatch(scope, batch.id);
    expect(result).toEqual({ ok: true, fileName: "work-orders.xlsx" });

    expect(await prisma.importBatch.count()).toBe(0);
    // The rows go with it, by cascade.
    expect(await prisma.importRow.count()).toBe(0);
  });

  it("writes an audit entry describing what was removed", async () => {
    const { fixture, scope } = await setup();
    const batch = await makeBatch(fixture.company.id, "DISCARDED", "august.xlsx");

    await deleteImportBatch(scope, batch.id);

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: "import_batch.deleted" },
    });
    expect(entry.entityId).toBe(batch.id);
    expect(entry.summary).toContain("august.xlsx");
    expect(entry.data).toMatchObject({ fileName: "august.xlsx", rowCount: 30 });
  });

  it("refuses a committed batch, because its work orders point at it", async () => {
    const { fixture, scope } = await setup();
    const batch = await makeBatch(fixture.company.id, "COMMITTED");

    const result = await deleteImportBatch(scope, batch.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/created work orders/i);
    expect(await prisma.importBatch.count()).toBe(1);
  });

  it("refuses a batch still being reviewed", async () => {
    const { fixture, scope } = await setup();
    const batch = await makeBatch(fixture.company.id, "PARSED");

    const result = await deleteImportBatch(scope, batch.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/discard/i);
    expect(await prisma.importBatch.count()).toBe(1);
  });

  it("will not orphan a work order even if the status says discarded", async () => {
    // The status is a label; the documents are the fact. If the two ever
    // disagree, the documents win and nothing is deleted.
    const { fixture, scope } = await setup();
    const batch = await makeBatch(fixture.company.id, "DISCARDED");
    const vendor = await makeVendor(fixture.company.id, "CONSULTANT", { name: "Abigail" });

    await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: vendor.id,
        workOrderNumber: "WO9001",
        issueDate: new Date(Date.UTC(2026, 7, 25)),
        dueDate: new Date(Date.UTC(2026, 8, 24)),
        currency: "PHP",
        fxRate: "1",
        total: "100.00",
        balanceDue: "100.00",
        importBatchId: batch.id,
      },
    });

    const result = await deleteImportBatch(scope, batch.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/still point at it/i);
    expect(await prisma.importBatch.count()).toBe(1);
    expect(await prisma.workOrder.count()).toBe(1);
  });

  it("cannot reach a batch belonging to another company", async () => {
    const { scope } = await setup();
    const other = await makeCompanyWithChart("Someone Else");
    const batch = await makeBatch(other.company.id, "DISCARDED");

    const result = await deleteImportBatch(scope, batch.id);
    expect(result).toEqual({ ok: false, reason: "That import is no longer here." });
    expect(await prisma.importBatch.count()).toBe(1);
  });
});
