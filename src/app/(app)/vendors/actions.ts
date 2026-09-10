"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { isSupportedCurrency } from "@/lib/currency";
import { PartyError, updateVendor } from "@/lib/parties";

/**
 * Creating and editing a vendor, out of the page so the New screen and the
 * vendor's own page call the same code.
 */

export async function create(formData: FormData) {
  const inner = await sectionScope("VENDORS");
  const name = String(formData.get("name") || "").trim();
  const currency = String(formData.get("defaultCurrency") || "").toUpperCase();
  if (!name) redirect("/vendors/new?error=name");
  if (!isSupportedCurrency(currency)) redirect("/vendors/new?error=currency");

  const vendor = await prisma.vendor.create({
    data: {
      companyId: inner.companyId,
      kind: "REGULAR",
      name,
      email: String(formData.get("email") || "").trim() || null,
      address: String(formData.get("address") || "").trim() || null,
      defaultCurrency: currency,
      defaultAccountId: String(formData.get("defaultAccountId") || "") || null,
      paymentTermsDays: Number(formData.get("paymentTermsDays") || 30),
      notes: String(formData.get("notes") || "").trim() || null,
      sendEmails: false,
    },
  });
  await writeAudit({
    companyId: inner.companyId,
    userId: inner.userId,
    action: "vendor.created",
    entityType: "Vendor",
    entityId: vendor.id,
    summary: name,
  });
  redirect(`/vendors/${vendor.id}`);
}

export async function save(formData: FormData) {
  const inner = await sectionScope("VENDORS");
  const vendorId = String(formData.get("vendorId") || "");
  try {
    await updateVendor({
      companyId: inner.companyId,
      userId: inner.userId,
      vendorId,
      kind: "REGULAR",
      formData,
    });
  } catch (thrown) {
    if (thrown instanceof PartyError) {
      redirect(`/vendors/${vendorId}?error=${thrown.problem}`);
    }
    throw thrown;
  }
  redirect(`/vendors/${vendorId}?saved=1`);
}
