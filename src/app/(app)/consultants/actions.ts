"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { isSupportedCurrency } from "@/lib/currency";
import { PartyError, updateVendor } from "@/lib/parties";

/**
 * Creating and editing a consultant, out of the page so that both the New
 * screen and the consultant's own page call exactly the same code. Two copies
 * of a form's validation is two places for it to drift.
 */

export async function create(formData: FormData) {
  const inner = await sectionScope("CONSULTANTS");
  const name = String(formData.get("name") || "").trim();
  const currency = String(formData.get("defaultCurrency") || "").toUpperCase();
  if (!name) redirect("/consultants/new?error=name");
  if (!isSupportedCurrency(currency)) redirect("/consultants/new?error=currency");

  const email = String(formData.get("email") || "").trim() || null;
  const sendEmails = formData.get("sendEmails") === "on";
  if (sendEmails && !email) redirect("/consultants/new?error=email");

  const vendor = await prisma.vendor.create({
    data: {
      companyId: inner.companyId,
      kind: "CONSULTANT",
      name,
      email,
      address: String(formData.get("address") || "").trim() || null,
      defaultCurrency: currency,
      defaultRate: String(formData.get("defaultRate") || "").trim() || null,
      defaultAccountId: String(formData.get("defaultAccountId") || "") || null,
      paymentTermsDays: Number(formData.get("paymentTermsDays") || 15),
      sendEmails,
      ccEmails: String(formData.get("ccEmails") || "")
        .split(/[,;\s]+/)
        .map((address) => address.trim())
        .filter(Boolean),
      externalRef: String(formData.get("externalRef") || "").trim() || null,
    },
  });
  await writeAudit({
    companyId: inner.companyId,
    userId: inner.userId,
    action: "consultant.created",
    entityType: "Vendor",
    entityId: vendor.id,
    summary: name,
  });
  redirect(`/consultants/${vendor.id}`);
}

export async function save(formData: FormData) {
  const inner = await sectionScope("CONSULTANTS");
  const vendorId = String(formData.get("vendorId") || "");
  try {
    await updateVendor({
      companyId: inner.companyId,
      userId: inner.userId,
      vendorId,
      kind: "CONSULTANT",
      formData,
    });
  } catch (thrown) {
    if (thrown instanceof PartyError) {
      redirect(`/consultants/${vendorId}?error=${thrown.problem}`);
    }
    throw thrown;
  }
  redirect(`/consultants/${vendorId}?saved=1`);
}
