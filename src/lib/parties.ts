import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { isSupportedCurrency } from "@/lib/currency";

/**
 * Editing customers, vendors and consultants (SPEC §6). Master data, so a
 * change here is a change to the default a *future* document picks up — the
 * currency, terms and account already written onto an issued invoice or an
 * approved work order stay exactly as they were. That is why this can be
 * edited freely while a posted document cannot.
 *
 * Nothing is hard-deleted; `isActive` is the off switch (SPEC §13).
 */

/** Which validation failed, as a code the screen turns into a sentence. */
export type PartyProblem = "name" | "currency" | "email" | "terms" | "rate" | "notFound";

export class PartyError extends Error {
  readonly problem: PartyProblem;

  constructor(problem: PartyProblem) {
    super(problem);
    this.name = "PartyError";
    this.problem = problem;
  }
}

/** "a@x.com, b@x.com; c@x.com" — commas, semicolons or spaces, all fine. */
export function parseEmailList(value: FormDataEntryValue | null): string[] {
  return String(value || "")
    .split(/[,;\s]+/)
    .map((email) => email.trim())
    .filter(Boolean);
}

function requiredName(value: FormDataEntryValue | null): string {
  const name = String(value || "").trim();
  if (!name) throw new PartyError("name");
  return name;
}

function requiredCurrency(value: FormDataEntryValue | null): string {
  const currency = String(value || "").toUpperCase();
  if (!isSupportedCurrency(currency)) throw new PartyError("currency");
  return currency;
}

/** Whole days, never negative — "Net -30" is not a thing. */
function terms(value: FormDataEntryValue | null, fallback: number): number {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0) throw new PartyError("terms");
  return days;
}

function optionalText(value: FormDataEntryValue | null): string | null {
  return String(value || "").trim() || null;
}

export async function updateCustomer(input: {
  companyId: string;
  userId: string;
  customerId: string;
  formData: FormData;
}) {
  const { formData } = input;
  const existing = await prisma.customer.findFirst({
    where: { id: input.customerId, companyId: input.companyId },
  });
  if (!existing) throw new PartyError("notFound");

  const name = requiredName(formData.get("name"));
  const customer = await prisma.customer.update({
    where: { id: existing.id },
    data: {
      name,
      emails: parseEmailList(formData.get("emails")),
      defaultCurrency: requiredCurrency(formData.get("defaultCurrency")),
      paymentTermsDays: terms(formData.get("paymentTermsDays"), existing.paymentTermsDays),
      billingAddress: optionalText(formData.get("billingAddress")),
      notes: optionalText(formData.get("notes")),
      isActive: formData.get("isActive") === "on",
    },
  });

  await writeAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: "customer.updated",
    entityType: "Customer",
    entityId: customer.id,
    summary: name === existing.name ? name : `${existing.name} → ${name}`,
    data: changed(existing, customer),
  });

  return customer;
}

export async function updateVendor(input: {
  companyId: string;
  userId: string;
  vendorId: string;
  kind: "REGULAR" | "CONSULTANT";
  formData: FormData;
}) {
  const { formData } = input;
  const existing = await prisma.vendor.findFirst({
    where: { id: input.vendorId, companyId: input.companyId, kind: input.kind },
  });
  if (!existing) throw new PartyError("notFound");

  const name = requiredName(formData.get("name"));
  const email = optionalText(formData.get("email"));
  const isConsultant = input.kind === "CONSULTANT";

  // Only consultants are emailed in bulk (SPEC §10.1), so only their form
  // carries these. The regular-vendor form has no field for them, and an
  // absent field must leave what is stored alone rather than blank it.
  const sendEmails = isConsultant && formData.get("sendEmails") === "on";
  if (sendEmails && !email) throw new PartyError("email");

  const rate = isConsultant ? String(formData.get("defaultRate") || "").trim() : "";
  if (rate && !(Number(rate) >= 0)) throw new PartyError("rate");

  const vendor = await prisma.vendor.update({
    where: { id: existing.id },
    data: {
      name,
      email,
      address: optionalText(formData.get("address")),
      defaultCurrency: requiredCurrency(formData.get("defaultCurrency")),
      defaultAccountId: String(formData.get("defaultAccountId") || "") || null,
      paymentTermsDays: terms(formData.get("paymentTermsDays"), existing.paymentTermsDays),
      notes: optionalText(formData.get("notes")),
      isActive: formData.get("isActive") === "on",
      ...(isConsultant
        ? {
            defaultRate: rate || null,
            sendEmails,
            ccEmails: parseEmailList(formData.get("ccEmails")),
            externalRef: optionalText(formData.get("externalRef")),
          }
        : {}),
    },
  });

  await writeAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: isConsultant ? "consultant.updated" : "vendor.updated",
    entityType: "Vendor",
    entityId: vendor.id,
    summary: name === existing.name ? name : `${existing.name} → ${name}`,
    data: changed(existing, vendor),
  });

  return vendor;
}

/**
 * Before and after for the fields that actually moved. An audit row saying
 * "updated" answers nothing; this one says what somebody changed.
 */
function changed<T extends Record<string, unknown>>(before: T, after: T): Prisma.InputJsonObject {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (key === "updatedAt") continue;
    const from = before[key];
    const to = after[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) diff[key] = { from, to };
  }
  // Through JSON so Decimal and Date arrive as the strings they serialise to,
  // rather than as objects Prisma will not take.
  return JSON.parse(JSON.stringify(diff)) as Prisma.InputJsonObject;
}
