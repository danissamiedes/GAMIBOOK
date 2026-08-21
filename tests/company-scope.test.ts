import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withCompanyScope, withFinancialScope, listUserCompanies } from "@/lib/company-scope";
import { CompanyAccessError, RoleError } from "@/lib/errors";
import { makeCompany, makeUser, prisma, resetDatabase } from "./helpers";

/**
 * SPEC §3 Phase 1 test: a user in company A cannot read company B's data.
 * SPEC §2: a consultant cannot reach anything financial.
 */
describe("company scoping", () => {
  let companyA: Awaited<ReturnType<typeof makeCompany>>;
  let companyB: Awaited<ReturnType<typeof makeCompany>>;
  let bookkeeperA: Awaited<ReturnType<typeof makeUser>>;
  let ownerB: Awaited<ReturnType<typeof makeUser>>;
  let consultantA: Awaited<ReturnType<typeof makeUser>>;
  let invitationInB: { id: string };

  beforeAll(async () => {
    await resetDatabase();
    companyA = await makeCompany("Company A", "PHP");
    companyB = await makeCompany("Company B", "USD");
    bookkeeperA = await makeUser("BOOKKEEPER", companyA.id);
    ownerB = await makeUser("OWNER", companyB.id);
    consultantA = await makeUser("CONSULTANT", companyA.id);

    // A company-scoped record living in B. In later phases this is an invoice;
    // the guarantee under test is the same one.
    invitationInB = await prisma.invitation.create({
      data: {
        companyId: companyB.id,
        email: "someone@example.test",
        role: "BOOKKEEPER",
        tokenHash: "hash-b",
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedByUserId: ownerB.id,
      },
    });
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("grants a member the scope for their own company", async () => {
    const scope = await withCompanyScope(bookkeeperA.id, companyA.id);
    expect(scope.companyId).toBe(companyA.id);
    expect(scope.role).toBe("BOOKKEEPER");
    expect(scope.where).toEqual({ companyId: companyA.id });
  });

  it("refuses a company the user is not a member of", async () => {
    await expect(withCompanyScope(bookkeeperA.id, companyB.id)).rejects.toBeInstanceOf(
      CompanyAccessError,
    );
  });

  it("cannot read company B's record by ID from company A's scope", async () => {
    const scope = await withCompanyScope(ownerB.id, companyB.id);
    // The owner of B can read it.
    await expect(
      prisma.invitation.findFirst({ where: { id: invitationInB.id, ...scope.where } }),
    ).resolves.not.toBeNull();

    // A's bookkeeper cannot even obtain a scope for B...
    await expect(withCompanyScope(bookkeeperA.id, companyB.id)).rejects.toBeInstanceOf(
      CompanyAccessError,
    );

    // ...and with their own scope, B's id resolves to nothing.
    const scopeA = await withCompanyScope(bookkeeperA.id, companyA.id);
    const leaked = await prisma.invitation.findFirst({
      where: { id: invitationInB.id, ...scopeA.where },
    });
    expect(leaked).toBeNull();
  });

  it("refuses a signed-out caller and a missing company", async () => {
    await expect(withCompanyScope(null, companyA.id)).rejects.toBeInstanceOf(CompanyAccessError);
    await expect(withCompanyScope(bookkeeperA.id, null)).rejects.toBeInstanceOf(CompanyAccessError);
  });

  it("refuses a disabled user even though the membership still exists", async () => {
    await prisma.user.update({ where: { id: bookkeeperA.id }, data: { isActive: false } });
    await expect(withCompanyScope(bookkeeperA.id, companyA.id)).rejects.toBeInstanceOf(
      CompanyAccessError,
    );
    await prisma.user.update({ where: { id: bookkeeperA.id }, data: { isActive: true } });
  });

  it("keeps consultants out of financial scope entirely", async () => {
    // The consultant is a legitimate member of company A...
    const scope = await withCompanyScope(consultantA.id, companyA.id);
    expect(scope.role).toBe("CONSULTANT");
    // ...and still cannot obtain a financial scope there.
    await expect(withFinancialScope(consultantA.id, companyA.id)).rejects.toBeInstanceOf(RoleError);
  });

  it("requireRole enforces the per-company role", async () => {
    const scope = await withCompanyScope(bookkeeperA.id, companyA.id);
    expect(() => scope.requireRole("OWNER")).toThrow(RoleError);
    expect(() => scope.requireRole("OWNER", "BOOKKEEPER")).not.toThrow();
    expect(scope.hasRole("BOOKKEEPER")).toBe(true);
    expect(scope.hasRole("OWNER")).toBe(false);
  });

  it("lists only the companies a user belongs to", async () => {
    const companies = await listUserCompanies(bookkeeperA.id);
    expect(companies.map((c) => c.id)).toEqual([companyA.id]);
  });

  it("gives the same person a different role in each company", async () => {
    const both = await prisma.user.create({
      data: { email: "both@example.test", name: "Both", passwordHash: "x" },
    });
    await prisma.membership.createMany({
      data: [
        { userId: both.id, companyId: companyA.id, role: "OWNER" },
        { userId: both.id, companyId: companyB.id, role: "CONSULTANT" },
      ],
    });

    expect((await withCompanyScope(both.id, companyA.id)).role).toBe("OWNER");
    expect((await withCompanyScope(both.id, companyB.id)).role).toBe("CONSULTANT");
    await expect(withFinancialScope(both.id, companyB.id)).rejects.toBeInstanceOf(RoleError);
  });
});
