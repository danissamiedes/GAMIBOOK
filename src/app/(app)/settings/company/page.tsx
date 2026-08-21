import { redirect } from "next/navigation";
import { currentUserId } from "@/lib/auth";
import { withFinancialScope } from "@/lib/company-scope";
import { resolveActiveCompanyId } from "@/lib/active-company";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { Alert, Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { COMMON_TIME_ZONES, MONTHS } from "@/lib/currency";

export default async function CompanySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const activeId = await resolveActiveCompanyId(userId);
  const scope = await withFinancialScope(userId, activeId);
  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const { saved } = await searchParams;

  async function save(formData: FormData) {
    "use server";
    const uid = await currentUserId();
    const cid = await resolveActiveCompanyId(uid ?? "");
    const inner = await withFinancialScope(uid, cid);

    const name = String(formData.get("name") || "").trim();
    const fiscalYearStartMonth = Number(formData.get("fiscalYearStartMonth"));
    const timeClockTimeZone = String(formData.get("timeClockTimeZone"));
    const operatingTimeZone = String(formData.get("operatingTimeZone"));

    if (!name) redirect("/settings/company");
    if (!Number.isInteger(fiscalYearStartMonth) || fiscalYearStartMonth < 1 || fiscalYearStartMonth > 12) {
      redirect("/settings/company");
    }

    await prisma.company.update({
      // Scoped by id AND companyId so this can never touch another company.
      where: { id: inner.companyId },
      data: { name, fiscalYearStartMonth, timeClockTimeZone, operatingTimeZone },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "company.updated",
      entityType: "Company",
      entityId: inner.companyId,
      data: { name, fiscalYearStartMonth, timeClockTimeZone, operatingTimeZone },
    });
    redirect("/settings/company?saved=1");
  }

  return (
    <>
      <PageHeader title="Company settings" description="Base currency cannot be changed." />
      <Card className="max-w-xl">
        {saved ? <Alert tone="success">Saved.</Alert> : null}
        <form action={save} className="mt-2 space-y-4">
          <Field label="Company name">
            <Input name="name" defaultValue={company.name} required />
          </Field>
          <Field
            label="Base currency"
            hint="Fixed at setup. Changing it after postings exist is not supported (SPEC §5)."
          >
            <Input value={company.baseCurrency} disabled readOnly />
          </Field>
          <Field label="Fiscal year starts">
            <Select name="fiscalYearStartMonth" defaultValue={company.fiscalYearStartMonth}>
              {MONTHS.map((month, index) => (
                <option key={month} value={index + 1}>
                  {month}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Time clock time zone"
            hint="Clock in/out display, day grouping and timesheet totals (SPEC §9)."
          >
            <Select name="timeClockTimeZone" defaultValue={company.timeClockTimeZone}>
              {COMMON_TIME_ZONES.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Operating time zone"
            hint="Scheduled jobs such as recurring invoicing. Deliberately separate from the clock zone."
          >
            <Select name="operatingTimeZone" defaultValue={company.operatingTimeZone}>
              {COMMON_TIME_ZONES.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit">Save changes</Button>
        </form>
      </Card>
    </>
  );
}
