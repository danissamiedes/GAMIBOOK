import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeAudit } from "@/lib/audit";
import { makeCompany, makeUser, prisma, resetDatabase } from "./helpers";

describe("audit log", () => {
  let companyId: string;
  let userId: string;

  beforeAll(async () => {
    await resetDatabase();
    const company = await makeCompany("Audited Co");
    companyId = company.id;
    userId = (await makeUser("OWNER", companyId)).id;
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("records who did what, when, against which company", async () => {
    await writeAudit({
      companyId,
      userId,
      action: "company.setup_completed",
      entityType: "Company",
      entityId: companyId,
      data: { baseCurrency: "PHP" },
    });

    const entries = await prisma.auditLog.findMany({ where: { companyId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "company.setup_completed",
      entityType: "Company",
      userId,
    });
    expect(entries[0].at).toBeInstanceOf(Date);
    expect(entries[0].data).toEqual({ baseCurrency: "PHP" });
  });

  it("survives the user being deleted — the trail outlives the account", async () => {
    const temp = await makeUser("BOOKKEEPER", companyId);
    await writeAudit({ companyId, userId: temp.id, action: "invite.created", entityType: "Invitation" });
    await prisma.membership.deleteMany({ where: { userId: temp.id } });
    await prisma.user.delete({ where: { id: temp.id } });

    const entry = await prisma.auditLog.findFirst({ where: { action: "invite.created" } });
    expect(entry).not.toBeNull();
    expect(entry?.userId).toBeNull();
  });
});
