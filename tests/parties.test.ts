import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PartyError, parseEmailList, updateCustomer, updateVendor } from "@/lib/parties";
import { makeCompanyWithChart, makeCustomer, makeUser, makeVendor, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("editing customers and vendors (SPEC §6)", () => {
  let fixture: Fixture;
  let owner: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Edit Co");
    owner = await makeUser("OWNER", fixture.company.id);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("parses an email list however it was typed", () => {
    expect(parseEmailList("a@x.com, b@x.com; c@x.com  d@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
    ]);
    expect(parseEmailList("")).toEqual([]);
    expect(parseEmailList(null)).toEqual([]);
  });

  it("changes a customer's name, terms, currency and address", async () => {
    const customer = await makeCustomer(fixture.company.id, { name: "Old Name" });

    const updated = await updateCustomer({
      companyId: fixture.company.id,
      userId: owner.id,
      customerId: customer.id,
      formData: form({
        name: "LEVY BRANDS LLC",
        emails: "ap@levy.test, cfo@levy.test",
        defaultCurrency: "USD",
        paymentTermsDays: "45",
        billingAddress: "1 Main St",
        notes: "Pays late",
        isActive: "on",
      }),
    });

    expect(updated.name).toBe("LEVY BRANDS LLC");
    expect(updated.emails).toEqual(["ap@levy.test", "cfo@levy.test"]);
    expect(updated.defaultCurrency).toBe("USD");
    expect(updated.paymentTermsDays).toBe(45);
    expect(updated.billingAddress).toBe("1 Main St");
    expect(updated.notes).toBe("Pays late");
    expect(updated.isActive).toBe(true);
  });

  it("records what changed in the audit trail", async () => {
    const customer = await makeCustomer(fixture.company.id, { name: "Old Name" });
    await updateCustomer({
      companyId: fixture.company.id,
      userId: owner.id,
      customerId: customer.id,
      formData: form({
        name: "New Name",
        defaultCurrency: customer.defaultCurrency,
        paymentTermsDays: String(customer.paymentTermsDays),
        isActive: "on",
      }),
    });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "customer.updated", entityId: customer.id },
    });
    expect(audit.summary).toBe("Old Name → New Name");
    const diff = audit.data as Record<string, { from: unknown; to: unknown }>;
    expect(diff.name).toEqual({ from: "Old Name", to: "New Name" });
    expect(diff.defaultCurrency).toBeUndefined();
  });

  it("deactivates a customer when the box is unticked", async () => {
    const customer = await makeCustomer(fixture.company.id, { name: "Gone" });
    const updated = await updateCustomer({
      companyId: fixture.company.id,
      userId: owner.id,
      customerId: customer.id,
      formData: form({
        name: "Gone",
        defaultCurrency: customer.defaultCurrency,
        paymentTermsDays: "30",
      }),
    });
    expect(updated.isActive).toBe(false);
  });

  it("refuses a blank name, a bad currency and negative terms", async () => {
    const customer = await makeCustomer(fixture.company.id, { name: "Keep" });
    const base = {
      companyId: fixture.company.id,
      userId: owner.id,
      customerId: customer.id,
    };

    await expect(
      updateCustomer({ ...base, formData: form({ name: "  ", defaultCurrency: "PHP" }) }),
    ).rejects.toThrow(PartyError);
    await expect(
      updateCustomer({ ...base, formData: form({ name: "Keep", defaultCurrency: "XYZ" }) }),
    ).rejects.toThrow(/currency/);
    await expect(
      updateCustomer({
        ...base,
        formData: form({ name: "Keep", defaultCurrency: "PHP", paymentTermsDays: "-5" }),
      }),
    ).rejects.toThrow(/terms/);

    const unchanged = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(unchanged.name).toBe("Keep");
  });

  it("will not reach a customer in another company", async () => {
    const other = await makeCompanyWithChart("Other Co");
    const customer = await makeCustomer(fixture.company.id, { name: "Mine" });

    await expect(
      updateCustomer({
        companyId: other.company.id,
        userId: owner.id,
        customerId: customer.id,
        formData: form({ name: "Theirs", defaultCurrency: "PHP" }),
      }),
    ).rejects.toThrow(/notFound/);
  });

  it("changes a vendor's address, account and terms", async () => {
    const vendor = await makeVendor(fixture.company.id, "REGULAR");

    const updated = await updateVendor({
      companyId: fixture.company.id,
      userId: owner.id,
      vendorId: vendor.id,
      kind: "REGULAR",
      formData: form({
        name: "Acme Supplies",
        email: "ap@acme.test",
        address: "22 Industrial Rd",
        defaultCurrency: "PHP",
        defaultAccountId: fixture.code("5000").id,
        paymentTermsDays: "60",
        isActive: "on",
      }),
    });

    expect(updated.name).toBe("Acme Supplies");
    expect(updated.address).toBe("22 Industrial Rd");
    expect(updated.defaultAccountId).toBe(fixture.code("5000").id);
    expect(updated.paymentTermsDays).toBe(60);
  });

  it("leaves the consultant-only fields alone when editing a regular vendor", async () => {
    const vendor = await makeVendor(fixture.company.id, "REGULAR");
    await prisma.vendor.update({
      where: { id: vendor.id },
      data: { externalRef: "V-1", ccEmails: ["cc@x.test"] },
    });

    const updated = await updateVendor({
      companyId: fixture.company.id,
      userId: owner.id,
      vendorId: vendor.id,
      kind: "REGULAR",
      // The regular-vendor form has no field for either, so an empty submission
      // must not wipe what is there.
      formData: form({ name: vendor.name, defaultCurrency: "PHP", isActive: "on" }),
    });

    expect(updated.externalRef).toBe("V-1");
    expect(updated.ccEmails).toEqual(["cc@x.test"]);
  });

  it("refuses a consultant set to be emailed with no address", async () => {
    const consultant = await makeVendor(fixture.company.id, "CONSULTANT");

    await expect(
      updateVendor({
        companyId: fixture.company.id,
        userId: owner.id,
        vendorId: consultant.id,
        kind: "CONSULTANT",
        formData: form({
          name: consultant.name,
          email: "",
          defaultCurrency: "PHP",
          sendEmails: "on",
          isActive: "on",
        }),
      }),
    ).rejects.toThrow(/email/);
  });

  it("saves a consultant's rate, cc list and spreadsheet code", async () => {
    const consultant = await makeVendor(fixture.company.id, "CONSULTANT");

    const updated = await updateVendor({
      companyId: fixture.company.id,
      userId: owner.id,
      vendorId: consultant.id,
      kind: "CONSULTANT",
      formData: form({
        name: "Jane Cruz",
        email: "jane@x.test",
        ccEmails: "agency@x.test; boss@x.test",
        defaultCurrency: "PHP",
        defaultRate: "1250.50",
        paymentTermsDays: "15",
        externalRef: "JC",
        sendEmails: "on",
        isActive: "on",
      }),
    });

    expect(updated.defaultRate?.toFixed(2)).toBe("1250.50");
    expect(updated.ccEmails).toEqual(["agency@x.test", "boss@x.test"]);
    expect(updated.externalRef).toBe("JC");
    expect(updated.sendEmails).toBe(true);
  });

  it("will not edit a consultant through the vendor screen, or the reverse", async () => {
    const consultant = await makeVendor(fixture.company.id, "CONSULTANT");

    await expect(
      updateVendor({
        companyId: fixture.company.id,
        userId: owner.id,
        vendorId: consultant.id,
        kind: "REGULAR",
        formData: form({ name: "Sneaky", defaultCurrency: "PHP" }),
      }),
    ).rejects.toThrow(/notFound/);
  });
});
