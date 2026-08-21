import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withCompanyScope, withSectionScope, ALL_SECTIONS } from "@/lib/company-scope";
import { SectionError, RoleError } from "@/lib/errors";
import { issueInvoice } from "@/lib/invoices/service";
import {
  makeCompanyWithChart,
  makeCustomer,
  makeDraftInvoice,
  makeUser,
  prisma,
  resetDatabase,
} from "./helpers";

/**
 * SPEC §2.1. The requirement is not "the menu is tidier" — it is that a
 * bookkeeper who handles vendor bills cannot see sales figures or consultant
 * information, including by typing a URL. So these tests go through the data
 * layer, which is where the guarantee has to live.
 */
describe("section access", () => {
  let fixture: Awaited<ReturnType<typeof makeCompanyWithChart>>;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let salesClerk: Awaited<ReturnType<typeof makeUser>>;
  let apClerk: Awaited<ReturnType<typeof makeUser>>;
  let consultant: Awaited<ReturnType<typeof makeUser>>;
  let invoiceId: string;
  let customerId: string;

  beforeAll(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Sectioned Co", "PHP");

    owner = await makeUser("OWNER", fixture.company.id);
    salesClerk = await makeUser("BOOKKEEPER", fixture.company.id, undefined, ["SALES"]);
    apClerk = await makeUser("BOOKKEEPER", fixture.company.id, undefined, ["VENDORS"]);
    consultant = await makeUser("CONSULTANT", fixture.company.id);

    const customer = await makeCustomer(fixture.company.id, { name: "Acme" });
    customerId = customer.id;
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      lines: [
        { description: "Work", quantity: "1", rate: "1000.00", incomeAccountId: fixture.code("4000").id },
      ],
    });
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });
    invoiceId = invoice.id;
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("gives an owner every section, and takes none away", async () => {
    const scope = await withCompanyScope(owner.id, fixture.company.id);
    expect(scope.sections.sort()).toEqual([...ALL_SECTIONS].sort());
    for (const section of ALL_SECTIONS) {
      await expect(withSectionScope(owner.id, fixture.company.id, section)).resolves.toBeTruthy();
    }
  });

  it("gives a consultant no sections at all", async () => {
    const scope = await withCompanyScope(consultant.id, fixture.company.id);
    expect(scope.sections).toEqual([]);
    // Role fails first for a consultant: they are not financial staff.
    await expect(
      withSectionScope(consultant.id, fixture.company.id, "SALES"),
    ).rejects.toBeInstanceOf(RoleError);
  });

  it("lets a sales bookkeeper into Sales and nowhere else", async () => {
    await expect(
      withSectionScope(salesClerk.id, fixture.company.id, "SALES"),
    ).resolves.toBeTruthy();

    for (const section of ["CONSULTANTS", "VENDORS", "BANKING", "REPORTS", "SETTINGS"] as const) {
      await expect(
        withSectionScope(salesClerk.id, fixture.company.id, section),
      ).rejects.toBeInstanceOf(SectionError);
    }
  });

  it("refuses a vendors-only user the sales data, by ID, not just by menu", async () => {
    // This is the requirement in one test: the AP clerk knows the invoice id
    // and asks for it directly.
    await expect(
      withSectionScope(apClerk.id, fixture.company.id, "SALES"),
    ).rejects.toBeInstanceOf(SectionError);

    // Their own section works, and its scope carries the company filter.
    const vendorScope = await withSectionScope(apClerk.id, fixture.company.id, "VENDORS");
    expect(vendorScope.where).toEqual({ companyId: fixture.company.id });

    // Any read of a sales document has to go through a SALES scope, which they
    // cannot obtain — so the invoice and the customer are unreachable.
    await expect(
      (async () => {
        const scope = await withSectionScope(apClerk.id, fixture.company.id, "SALES");
        return prisma.invoice.findFirst({ where: { id: invoiceId, ...scope.where } });
      })(),
    ).rejects.toBeInstanceOf(SectionError);

    await expect(
      (async () => {
        const scope = await withSectionScope(apClerk.id, fixture.company.id, "SALES");
        return prisma.customer.findFirst({ where: { id: customerId, ...scope.where } });
      })(),
    ).rejects.toBeInstanceOf(SectionError);
  });

  it("names the section in the refusal, so the user can ask for the right thing", async () => {
    await expect(
      withSectionScope(apClerk.id, fixture.company.id, "CONSULTANTS"),
    ).rejects.toThrow(/Consultants section/);
  });

  it("keeps sections per company, like roles", async () => {
    const other = await makeCompanyWithChart("Second Co", "USD");
    await prisma.membership.create({
      data: {
        userId: apClerk.id,
        companyId: other.company.id,
        role: "BOOKKEEPER",
        sections: ["SALES", "REPORTS"],
      },
    });

    // Vendors here, sales there — the same person, two different remits.
    await expect(
      withSectionScope(apClerk.id, fixture.company.id, "SALES"),
    ).rejects.toBeInstanceOf(SectionError);
    await expect(
      withSectionScope(apClerk.id, other.company.id, "SALES"),
    ).resolves.toBeTruthy();
    await expect(
      withSectionScope(apClerk.id, other.company.id, "VENDORS"),
    ).rejects.toBeInstanceOf(SectionError);
  });

  it("still refuses a section in a company the user does not belong to", async () => {
    const stranger = await makeCompanyWithChart("Stranger Co", "PHP");
    await expect(withSectionScope(salesClerk.id, stranger.company.id, "SALES")).rejects.toThrow();
  });
});
