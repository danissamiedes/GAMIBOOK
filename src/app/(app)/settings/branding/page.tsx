import { pageTitle } from "@/lib/brand";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { storage, storageKeys } from "@/lib/storage";
import { invalidatePdf } from "@/lib/pdf/render";
import { Alert, Button, Card, Field, Input, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Branding") };

/** SPEC §11: what appears on the invoice, work order and receipt. */
export default async function BrandingPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const scope = await sectionScope("SETTINGS");
  const params = await searchParams;
  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });

  async function save(formData: FormData) {
    "use server";
    const inner = await sectionScope("SETTINGS");

    const logo = formData.get("logo");
    let logoFileKey = company.logoFileKey;

    if (logo instanceof File && logo.size > 0) {
      if (logo.size > 2 * 1024 * 1024) {
        redirect("/settings/branding?error=Logo%20must%20be%20under%202%20MB");
      }
      const extension = logo.type === "image/jpeg" ? "jpg" : logo.type === "image/png" ? "png" : null;
      if (!extension) redirect("/settings/branding?error=Logo%20must%20be%20a%20PNG%20or%20JPEG");

      logoFileKey = storageKeys.companyLogo(inner.companyId, `logo.${extension}`);
      await storage().put(logoFileKey, Buffer.from(await logo.arrayBuffer()), logo.type);
    }

    await prisma.company.update({
      where: { id: inner.companyId },
      data: {
        legalName: String(formData.get("legalName") || "").trim() || null,
        addressLine1: String(formData.get("addressLine1") || "").trim() || null,
        addressLine2: String(formData.get("addressLine2") || "").trim() || null,
        city: String(formData.get("city") || "").trim() || null,
        region: String(formData.get("region") || "").trim() || null,
        postalCode: String(formData.get("postalCode") || "").trim() || null,
        country: String(formData.get("country") || "").trim() || null,
        email: String(formData.get("email") || "").trim() || null,
        phone: String(formData.get("phone") || "").trim() || null,
        taxNumber: String(formData.get("taxNumber") || "").trim() || null,
        footerText: String(formData.get("footerText") || "").trim() || null,
        logoFileKey,
      },
    });

    // Cached PDFs carry the old branding; they are a cache, so drop them.
    const invoices = await prisma.invoice.findMany({
      where: { companyId: inner.companyId },
      select: { id: true },
    });
    for (const invoice of invoices) await invalidatePdf(inner.companyId, "invoice", invoice.id);
    const workOrders = await prisma.workOrder.findMany({
      where: { companyId: inner.companyId },
      select: { id: true },
    });
    for (const workOrder of workOrders) {
      await invalidatePdf(inner.companyId, "work-order", workOrder.id);
    }

    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "company.branding_updated",
      entityType: "Company",
      entityId: inner.companyId,
    });
    redirect("/settings/branding?saved=1");
  }

  return (
    <>
      <PageHeader
        title="Branding"
        description="Appears on every invoice, work order and receipt. Changing it clears the cached PDFs so they regenerate."
      />
      {params.saved ? <Alert tone="success">Saved. Existing PDFs will regenerate.</Alert> : null}
      {params.error ? <Alert tone="error">{params.error}</Alert> : null}

      <Card className="mt-4 max-w-2xl">
        <form action={save} className="space-y-4">
          <Field label="Legal name" hint={`Defaults to "${company.name}" if left blank.`}>
            <Input name="legalName" defaultValue={company.legalName ?? ""} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Address line 1">
              <Input name="addressLine1" defaultValue={company.addressLine1 ?? ""} />
            </Field>
            <Field label="Address line 2">
              <Input name="addressLine2" defaultValue={company.addressLine2 ?? ""} />
            </Field>
            <Field label="City">
              <Input name="city" defaultValue={company.city ?? ""} />
            </Field>
            <Field label="Region">
              <Input name="region" defaultValue={company.region ?? ""} />
            </Field>
            <Field label="Postal code">
              <Input name="postalCode" defaultValue={company.postalCode ?? ""} />
            </Field>
            <Field label="Country">
              <Input name="country" defaultValue={company.country ?? ""} />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" defaultValue={company.email ?? ""} />
            </Field>
            <Field label="Phone">
              <Input name="phone" defaultValue={company.phone ?? ""} />
            </Field>
          </div>
          <Field label="Tax / registration number">
            <Input name="taxNumber" defaultValue={company.taxNumber ?? ""} />
          </Field>
          <Field
            label="Footer text"
            hint="Payment instructions and bank details. Printed at the foot of every document."
          >
            <Input name="footerText" defaultValue={company.footerText ?? ""} />
          </Field>
          <Field label="Logo" hint="PNG or JPEG, under 2 MB.">
            <Input name="logo" type="file" accept="image/png,image/jpeg" />
          </Field>
          {company.logoFileKey ? (
            <p className="text-xs text-slate-500">A logo is uploaded. Choosing a file replaces it.</p>
          ) : null}
          <Button type="submit">Save branding</Button>
        </form>
      </Card>
    </>
  );
}
