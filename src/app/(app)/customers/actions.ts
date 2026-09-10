"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { isSupportedCurrency } from "@/lib/currency";
import { parseEmailList } from "@/lib/parties";
import { PartyError, updateCustomer } from "@/lib/parties";

/**
 * Creating and editing a customer, out of the page so the New screen and the
 * customer's own page call the same code.
 */

export async function create(formData: FormData) {
  const inner = await sectionScope("SALES");
  const name = String(formData.get("name") || "").trim();
  const currency = String(formData.get("defaultCurrency") || "").toUpperCase();
  const emails = parseEmailList(formData.get("emails"));
  const paymentTermsDays = Number(formData.get("paymentTermsDays") || 30);

  if (!name) redirect("/customers/new?error=name");
  if (!isSupportedCurrency(currency)) redirect("/customers/new?error=currency");

  const customer = await prisma.customer.create({
    data: {
      companyId: inner.companyId,
      name,
      emails,
      defaultCurrency: currency,
      paymentTermsDays: Number.isFinite(paymentTermsDays) ? paymentTermsDays : 30,
      billingAddress: String(formData.get("billingAddress") || "").trim() || null,
      notes: String(formData.get("notes") || "").trim() || null,
    },
  });
  await writeAudit({
    companyId: inner.companyId,
    userId: inner.userId,
    action: "customer.created",
    entityType: "Customer",
    entityId: customer.id,
    summary: name,
  });
  redirect(`/customers/${customer.id}`);
}

export async function save(formData: FormData) {
  const inner = await sectionScope("SALES");
  const customerId = String(formData.get("customerId") || "");
  try {
    await updateCustomer({
      companyId: inner.companyId,
      userId: inner.userId,
      customerId,
      formData,
    });
  } catch (thrown) {
    if (thrown instanceof PartyError) {
      redirect(`/customers/${customerId}?error=${thrown.problem}`);
    }
    throw thrown;
  }
  redirect(`/customers/${customerId}?saved=1`);
}
